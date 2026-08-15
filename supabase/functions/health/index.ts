/**
 * Health check (M14 spec AI): answers "is the backend basically alive?"
 * without exposing internals. Verifies the database answers a trivial query
 * through PostgREST. No auth required (it must work when auth is broken),
 * no data returned beyond status + timestamp.
 */

import { json } from '../_shared/billing.ts';

Deno.serve(async () => {
  const startedAt = Date.now();
  let database = 'ok';
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!url || !anonKey) throw new Error('unconfigured');
    const res = await fetch(`${url}/rest/v1/feature_flags?select=key&limit=1`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    // anon has no grant on feature_flags — ANY well-formed PostgREST answer
    // (200/401/403/406) proves the database stack is up; only network/5xx
    // failures count as down.
    if (res.status >= 500) database = 'down';
  } catch {
    database = 'down';
  }
  return json(
    {
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      latency_ms: Date.now() - startedAt,
      checked_at: new Date().toISOString(),
    },
    database === 'ok' ? 200 : 503
  );
});
