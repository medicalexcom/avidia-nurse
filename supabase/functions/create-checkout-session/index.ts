/**
 * Create a Stripe Checkout session for the PRO subscription (M14 spec E/M/R).
 *
 * The client NEVER touches card data or Stripe secrets: it calls this
 * function with its Supabase JWT and gets back a Stripe-hosted checkout URL
 * (spec R/T — Stripe's UI handles all payment details). The session carries
 * `client_reference_id` = the Supabase user id, which is how the webhook
 * attributes the resulting subscription.
 *
 * Configuration (Stripe dashboard, per environment — documented in
 * docs/worklogs/M14.md):
 *   STRIPE_SECRET_KEY   test/live secret key (server-only)
 *   STRIPE_PRICE_ID_PRO the recurring price for the PRO plan
 *   BILLING_RETURN_URL  where checkout returns (the app's billing screen)
 */

import { json, requireUser, stripeRequest } from '../_shared/billing.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let user;
  try {
    user = await requireUser(req);
  } catch {
    return json({ error: 'unauthorized' }, 401);
  }

  const priceId = Deno.env.get('STRIPE_PRICE_ID_PRO');
  const returnUrl = Deno.env.get('BILLING_RETURN_URL');
  if (!priceId || !returnUrl || !Deno.env.get('STRIPE_SECRET_KEY')) {
    // Honest not-configured (spec I applies to web too): the client shows
    // "billing not available yet" instead of a broken flow.
    return json({ error: 'billing_not_configured' }, 503);
  }

  try {
    const session = await stripeRequest('checkout/sessions', {
      mode: 'subscription',
      client_reference_id: user.id,
      ...(user.email ? { customer_email: user.email } : {}),
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: `${returnUrl}?checkout=success`,
      cancel_url: `${returnUrl}?checkout=cancelled`,
    });
    console.log(JSON.stringify({ level: 'info', fn: 'create-checkout-session', ok: true }));
    return json({ url: session.url });
  } catch {
    return json({ error: 'checkout_failed' }, 500);
  }
});
