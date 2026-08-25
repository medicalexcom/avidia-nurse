import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  canUser,
  shouldTrustCachedEntitlements,
  type Capability,
  type Plan,
} from '@avidia/entitlements';

import { removeMaterialObjects } from '../materials/materialStorage';

/**
 * Billing / entitlements client API — M14 (spec K/M/N/R/AW/AK/AL).
 *
 * THE SERVER IS AUTHORITATIVE. This module fetches the entitlement payload
 * computed by `get_my_entitlements()` (SECURITY DEFINER, reads the
 * webhook-written subscriptions table) and caches it locally ONLY to survive
 * transient outages: the cache is trusted for a bounded window
 * (shouldTrustCachedEntitlements, 72 h) and never beyond (spec AW —
 * tradeoff documented in ADR-0037). Nothing here can GRANT premium: the
 * database enforces plan limits in triggers regardless of what the client
 * believes (spec K).
 */

export interface EntitlementsPayload {
  rules_version: number;
  plan: Plan;
  enforced: boolean;
  capabilities: Capability[];
  limits: {
    max_active_courses: number | null;
    monthly: Record<string, number | null>;
  };
  usage: Record<string, number>;
  period_key: string;
  subscriptions: Array<{
    provider: string;
    status: string;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    trial_end: string | null;
  }>;
  fetched_at: string;
}

const CACHE_KEY = 'avidia.entitlements.v1';

export async function fetchEntitlements(client: SupabaseClient): Promise<EntitlementsPayload> {
  const { data, error } = await client.rpc('get_my_entitlements');
  if (error) throw error;
  const payload = data as EntitlementsPayload;
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Cache persistence is best-effort; entitlements still work this session.
  }
  return payload;
}

/**
 * Outage fallback (spec AW): return the cached payload only while it is
 * still inside the trust window. An expired or unparseable cache yields
 * null — the caller then treats the user as FREE-but-unenforced rather
 * than granting stale PRO forever.
 */
export async function readTrustedCache(now = new Date()): Promise<EntitlementsPayload | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw) as EntitlementsPayload;
    if (!shouldTrustCachedEntitlements(payload.fetched_at, now)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function clearEntitlementsCache(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CACHE_KEY);
  } catch {
    // best-effort
  }
}

/** Client-side capability convenience — NEVER authoritative (spec K/N). */
export function entitlementsAllow(
  payload: EntitlementsPayload | null,
  capability: Capability
): boolean {
  if (!payload) return canUser(null, capability);
  return canUser({ plan: payload.plan, enforced: payload.enforced }, capability);
}

// ---------------------------------------------------------------------------
// Stripe web billing (spec E/R) — both flows end on Stripe-hosted pages.
// ---------------------------------------------------------------------------

export type BillingLinkResult =
  | { status: 'ok'; url: string }
  | { status: 'not_configured' }
  | { status: 'no_billing_account' }
  | { status: 'error'; message: string };

async function invokeBillingFunction(
  client: SupabaseClient,
  fn: 'create-checkout-session' | 'create-billing-portal-session'
): Promise<BillingLinkResult> {
  const { data, error } = await client.functions.invoke(fn, { body: {} });
  if (error) {
    // supabase-js surfaces non-2xx as FunctionsHttpError with the response.
    const status = (error as { context?: { status?: number } }).context?.status;
    if (status === 503) return { status: 'not_configured' };
    if (status === 404) return { status: 'no_billing_account' };
    return { status: 'error', message: 'Billing is unavailable right now. Please try again.' };
  }
  const url = (data as { url?: string })?.url;
  if (!url) return { status: 'error', message: 'Billing is unavailable right now.' };
  return { status: 'ok', url };
}

export function startCheckout(client: SupabaseClient): Promise<BillingLinkResult> {
  return invokeBillingFunction(client, 'create-checkout-session');
}

export function openBillingPortal(client: SupabaseClient): Promise<BillingLinkResult> {
  return invokeBillingFunction(client, 'create-billing-portal-session');
}

// ---------------------------------------------------------------------------
// Data export + account deletion (spec AK/AL)
// ---------------------------------------------------------------------------

export async function exportMyData(client: SupabaseClient): Promise<unknown> {
  const { data, error } = await client.rpc('export_my_data');
  if (error) throw error;
  return data;
}

export type DeleteAccountResult =
  { status: 'deleted' } | { status: 'active_subscription' } | { status: 'error'; message: string };

/**
 * Storage object cleanup can no longer happen inside delete_my_account()
 * itself (Supabase rejects direct SQL deletes against storage.objects —
 * migration 0022), so it happens here, client-side, in a specific order:
 * list the caller's own document storage keys FIRST (read-only, safe
 * regardless of outcome), then call the guarded RPC, and only remove those
 * objects AFTER it succeeds. That ordering matters: if the RPC refuses
 * (active subscription) or errors, nothing has been deleted yet — the
 * guard stays authoritative and no file is destroyed on a blocked attempt.
 */
export async function deleteMyAccount(client: SupabaseClient): Promise<DeleteAccountResult> {
  const { data: docs } = await client.from('documents').select('storage_key');
  const storageKeys = ((docs ?? []) as Array<{ storage_key: string | null }>)
    .map((doc) => doc.storage_key)
    .filter((key): key is string => Boolean(key));

  const { error } = await client.rpc('delete_my_account');
  if (error) {
    if (typeof error.message === 'string' && error.message.includes('ACTIVE_SUBSCRIPTION')) {
      return { status: 'active_subscription' };
    }
    return { status: 'error', message: 'Account deletion failed. Please try again.' };
  }

  // Best-effort from here: the account and every DB row that referenced
  // these objects are already gone, so a failure here can't be surfaced to
  // (or retried by) a user who no longer has an account. Orphaned objects
  // stay under the deleted owner's private storage path, unreachable by
  // anyone else (storage policies are owner-scoped) — never a data leak,
  // just a cleanup gap (docs/KNOWN_LIMITATIONS.md).
  if (storageKeys.length > 0) {
    try {
      await removeMaterialObjects(client, storageKeys);
    } catch {
      // intentionally swallowed — see comment above.
    }
  }

  await clearEntitlementsCache();
  return { status: 'deleted' };
}
