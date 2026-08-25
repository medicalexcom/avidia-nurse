/**
 * Generic edge-function helpers: a thin service-role PostgREST client, JWT
 * user resolution, and a JSON response helper.
 *
 * Extracted from billing.ts (which re-exports these for backward
 * compatibility with the existing billing functions' imports) so that
 * non-billing functions — e.g. content-review — have a home that isn't
 * named after billing. Nothing here is billing-specific.
 *
 * Secrets used here (SUPABASE_SERVICE_ROLE_KEY) are function secrets set via
 * `supabase secrets set` — NEVER EXPO_PUBLIC, never reach any client bundle.
 */

/**
 * Every browser call to an edge function is cross-origin (the app is served
 * from GitHub Pages, the function from *.supabase.co), so the browser sends
 * a CORS preflight (OPTIONS) before the real request. Without these headers
 * on both the preflight response and the real one, the browser blocks the
 * request before it ever reaches this function's logic — the caller sees a
 * generic network failure, not a 401/403/whatever this function meant to
 * return. Every function built on this helper must handle OPTIONS itself
 * (see content-review/index.ts for the pattern); this only covers the
 * headers, since the preflight short-circuit has to happen before any
 * auth/body work.
 */
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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
    /**
     * PATCH rows matching `match` (each value compared with `eq.`). Used by
     * content-review to apply reviewer edits/decisions — service-role writes
     * bypass RLS the same way `select`/`insert`/`upsert` already do, which is
     * exactly why these actions must be gated by requireReviewer, not RLS.
     */
    async update(
      table: string,
      match: Record<string, string>,
      patch: Record<string, unknown>
    ): Promise<Response> {
      const qs = Object.entries(match)
        .map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`)
        .join('&');
      return await fetch(`${url}/rest/v1/${table}?${qs}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
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
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
