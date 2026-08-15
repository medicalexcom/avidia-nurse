/**
 * Create a Stripe Billing Portal session (M14 spec R).
 *
 * Payment-method updates, cancellation and invoices all happen in Stripe's
 * hosted portal — we build NO custom card UI. The caller must have a Stripe
 * subscription row (that's where the customer id comes from); the row is
 * read with the service key AFTER the JWT identifies the user, so one user
 * can never open another's portal (IDOR, spec AP).
 */

import { json, requireUser, serviceClient, stripeRequest } from '../_shared/billing.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let user;
  try {
    user = await requireUser(req);
  } catch {
    return json({ error: 'unauthorized' }, 401);
  }

  const returnUrl = Deno.env.get('BILLING_RETURN_URL');
  if (!returnUrl || !Deno.env.get('STRIPE_SECRET_KEY')) {
    return json({ error: 'billing_not_configured' }, 503);
  }

  try {
    const db = serviceClient();
    const rows = (await db.select(
      'subscriptions',
      `select=provider_customer_id&provider=eq.stripe&user_id=eq.${user.id}` +
        `&order=updated_at.desc&limit=1`
    )) as Array<{ provider_customer_id: string }>;
    const customerId = rows[0]?.provider_customer_id;
    if (!customerId) return json({ error: 'no_billing_account' }, 404);

    const session = await stripeRequest('billing_portal/sessions', {
      customer: customerId,
      return_url: returnUrl,
    });
    console.log(JSON.stringify({ level: 'info', fn: 'create-billing-portal-session', ok: true }));
    return json({ url: session.url });
  } catch {
    return json({ error: 'portal_failed' }, 500);
  }
});
