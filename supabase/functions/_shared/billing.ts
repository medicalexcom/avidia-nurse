/**
 * Shared billing helpers for the M14 edge functions (spec E/F/G/T/U).
 *
 * These functions run on Supabase Edge Functions (Deno). They are kept
 * DELIBERATELY THIN: all lifecycle mapping logic is mirrored from the
 * unit-tested pure package `@avidia/entitlements` (packages/entitlements) —
 * that package is the canonical, tested definition of every mapping below.
 * If you change a mapping here, change it there first and port the tests'
 * verdicts.
 *
 * Secrets used here (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 * SUPABASE_SERVICE_ROLE_KEY) are function secrets set via
 * `supabase secrets set` — they are NEVER EXPO_PUBLIC and never reach any
 * client bundle (spec U).
 */

/** Mirrors HANDLED_STRIPE_EVENTS in packages/entitlements/src/webhook.ts. */
export const HANDLED_STRIPE_EVENTS = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
]);

/** Mirrors normalizeStripeStatus in packages/entitlements/src/status.ts. */
export function normalizeStripeStatus(stripeStatus: string): string {
  switch (stripeStatus) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    default:
      // Unknown vocabulary NEVER grants access (spec D/J).
      return 'expired';
  }
}

function epochToIso(epochSeconds: unknown): string | null {
  return typeof epochSeconds === 'number' ? new Date(epochSeconds * 1000).toISOString() : null;
}

/** Mirrors snapshotFromStripeSubscription in packages/entitlements. */
// deno-lint-ignore no-explicit-any
export function snapshotFromStripeSubscription(subscription: any, deleted = false) {
  return {
    provider: 'stripe',
    provider_customer_id: String(subscription.customer),
    provider_subscription_id: String(subscription.id),
    product_id: subscription.items?.data?.[0]?.price?.product ?? null,
    plan: 'pro',
    status: deleted ? 'canceled' : normalizeStripeStatus(String(subscription.status)),
    current_period_start: epochToIso(subscription.current_period_start),
    current_period_end: epochToIso(subscription.current_period_end),
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    trial_end: epochToIso(subscription.trial_end),
  };
}

/**
 * Verify a Stripe webhook signature (spec F). Stripe signs
 * `${timestamp}.${rawBody}` with HMAC-SHA256 using the endpoint secret; the
 * Stripe-Signature header carries `t=<ts>,v1=<sig>[,v1=...]`.
 * Constant-time comparison; deliveries older than the tolerance are
 * rejected to blunt replay.
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSeconds = 300
): Promise<boolean> {
  if (!signatureHeader) return false;
  const parts = new Map<string, string[]>();
  for (const pair of signatureHeader.split(',')) {
    const idx = pair.indexOf('=');
    if (idx < 1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    parts.set(key, [...(parts.get(key) ?? []), value]);
  }
  const timestamp = parts.get('t')?.[0];
  const candidates = parts.get('v1') ?? [];
  if (!timestamp || candidates.length === 0) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  for (const candidate of candidates) {
    if (timingSafeEqual(expected, candidate)) return true;
  }
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Minimal service-role PostgREST client (no SDK dependency needed). */
export function serviceClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) throw new Error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
  return {
    async select(table: string, query: string): Promise<unknown[]> {
      const res = await fetch(`${url}/rest/v1/${table}?${query}`, { headers });
      if (!res.ok) throw new Error(`select ${table} failed: ${res.status}`);
      return await res.json();
    },
    async insert(table: string, row: Record<string, unknown>): Promise<Response> {
      return await fetch(`${url}/rest/v1/${table}`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      });
    },
    async upsert(
      table: string,
      row: Record<string, unknown>,
      onConflict: string
    ): Promise<Response> {
      return await fetch(`${url}/rest/v1/${table}?on_conflict=${onConflict}`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      });
    },
  };
}

/** Resolve the calling user from the request's Authorization JWT. */
export async function requireUser(req: Request): Promise<{ id: string; email: string | null }> {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const auth = req.headers.get('Authorization');
  if (!url || !anonKey || !auth) throw new Error('unauthorized');
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: auth },
  });
  if (!res.ok) throw new Error('unauthorized');
  const user = await res.json();
  if (!user?.id) throw new Error('unauthorized');
  return { id: user.id, email: user.email ?? null };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Call the Stripe REST API with form encoding (no SDK — keeps functions thin). */
export async function stripeRequest(
  path: string,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const secretKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY not configured');
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    // Never leak Stripe error internals to clients; log a structured line.
    console.error(
      JSON.stringify({ level: 'error', fn: 'stripeRequest', path, status: res.status })
    );
    throw new Error('stripe request failed');
  }
  return data;
}
