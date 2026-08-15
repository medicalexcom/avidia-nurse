/**
 * Stripe webhook (M14 spec F/G) — the ONLY writer of subscription state.
 *
 * Contract:
 *   1. Verify the Stripe-Signature header (HMAC-SHA256 over `${t}.${body}`,
 *      constant-time compare, 5-minute replay tolerance). Unverified
 *      requests get 400 and touch nothing — webhook spoofing (spec AP) dies
 *      here.
 *   2. Record the provider event ID in billing_events. A duplicate delivery
 *      violates the unique index → acknowledged with 200, processed zero
 *      times (idempotency, spec G / billing case AY-D).
 *   3. Map the event to a normalized subscription snapshot (mapping mirrors
 *      the unit-tested `@avidia/entitlements`) and upsert it keyed by
 *      (provider, provider_subscription_id).
 *
 * The user link comes from checkout `client_reference_id` (set to the
 * Supabase user id by create-checkout-session) or, for later lifecycle
 * events, from the existing row / customer mapping. Unknown events are
 * acknowledged and ignored. Errors return 500 so Stripe retries.
 *
 * Deploy with --no-verify-jwt (Stripe cannot send a Supabase JWT); the
 * signature IS the authentication.
 */

import {
  HANDLED_STRIPE_EVENTS,
  json,
  serviceClient,
  snapshotFromStripeSubscription,
  verifyStripeSignature,
} from '../_shared/billing.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!webhookSecret) {
    console.error(JSON.stringify({ level: 'error', fn: 'stripe-webhook', msg: 'not configured' }));
    return json({ error: 'not configured' }, 500);
  }

  const rawBody = await req.text();
  const verified = await verifyStripeSignature(
    rawBody,
    req.headers.get('Stripe-Signature'),
    webhookSecret
  );
  if (!verified) {
    console.error(JSON.stringify({ level: 'warn', fn: 'stripe-webhook', msg: 'bad signature' }));
    return json({ error: 'invalid signature' }, 400);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: 'invalid payload' }, 400);
  }
  const eventId = String(event?.id ?? '');
  const eventType = String(event?.type ?? '');
  if (!eventId || !eventType) return json({ error: 'invalid payload' }, 400);

  // Unhandled events: acknowledge without recording (Stripe sends many).
  if (!HANDLED_STRIPE_EVENTS.has(eventType)) return json({ received: true, ignored: true });

  const db = serviceClient();

  try {
    // --- Resolve the subscription object + user for this event ------------
    // deno-lint-ignore no-explicit-any
    const object: any = event.data?.object ?? {};
    let subscription: Record<string, unknown> | null = null;
    let userId: string | null = null;

    if (eventType === 'checkout.session.completed') {
      // client_reference_id was set to the Supabase user id at checkout.
      userId = object.client_reference_id ?? null;
      if (object.subscription) {
        subscription = await stripeRetrieveSubscription(String(object.subscription));
      }
    } else if (eventType === 'invoice.payment_failed') {
      const subId = object.subscription ?? object.parent?.subscription_details?.subscription;
      if (subId) subscription = await stripeRetrieveSubscription(String(subId));
    } else {
      // customer.subscription.* events carry the subscription itself.
      subscription = object;
    }

    if (!subscription) {
      // Nothing to apply (e.g. one-off invoice) — acknowledge.
      return json({ received: true, ignored: true });
    }

    const snapshot = snapshotFromStripeSubscription(
      subscription,
      eventType === 'customer.subscription.deleted'
    );

    // If the event didn't carry the user, find the existing row for this
    // provider subscription (created at checkout time).
    if (!userId) {
      const rows = (await db.select(
        'subscriptions',
        `select=user_id&provider=eq.stripe&provider_subscription_id=eq.${encodeURIComponent(
          snapshot.provider_subscription_id
        )}&limit=1`
      )) as Array<{ user_id: string }>;
      userId = rows[0]?.user_id ?? null;
    }
    if (!userId) {
      // A subscription we cannot attribute — log and 500 so Stripe retries
      // (the checkout.session.completed that links it may still be in flight).
      console.error(
        JSON.stringify({ level: 'error', fn: 'stripe-webhook', msg: 'unattributed', eventType })
      );
      return json({ error: 'unattributed subscription' }, 500);
    }

    // --- Idempotency gate (spec G) ---------------------------------------
    const inserted = await db.insert('billing_events', {
      provider: 'stripe',
      provider_event_id: eventId,
      event_type: eventType,
      user_id: userId,
    });
    if (inserted.status === 409) {
      // Duplicate delivery: acknowledge, reprocess nothing (case AY-D).
      return json({ received: true, duplicate: true });
    }
    if (!inserted.ok) throw new Error(`billing_events insert failed: ${inserted.status}`);

    // --- Apply the snapshot ----------------------------------------------
    const upserted = await db.upsert(
      'subscriptions',
      { user_id: userId, ...snapshot },
      'provider,provider_subscription_id'
    );
    if (!upserted.ok) throw new Error(`subscriptions upsert failed: ${upserted.status}`);

    console.log(
      JSON.stringify({
        level: 'info',
        fn: 'stripe-webhook',
        eventType,
        status: snapshot.status,
        // No PII/PHI, no payloads — identifiers only (spec AF/AH).
      })
    );
    return json({ received: true });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        fn: 'stripe-webhook',
        eventType,
        msg: err instanceof Error ? err.message : 'unknown',
      })
    );
    return json({ error: 'processing failed' }, 500);
  }
});

async function stripeRetrieveSubscription(id: string): Promise<Record<string, unknown>> {
  const secretKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY not configured');
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!res.ok) throw new Error(`subscription retrieve failed: ${res.status}`);
  return await res.json();
}
