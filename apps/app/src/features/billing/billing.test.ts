import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  clearEntitlementsCache,
  deleteMyAccount,
  entitlementsAllow,
  fetchEntitlements,
  openBillingPortal,
  readTrustedCache,
  startCheckout,
  type EntitlementsPayload,
} from './billingApi';
import { purchases } from './purchases';

/**
 * Billing feature tests — M14 (spec K/N/R/AW/AK/AL/AY at the client level).
 * The client is NEVER authoritative; these tests pin the failure behavior
 * (bounded cache trust, honest not-configured store stub, deletion guard
 * surfacing) rather than any entitlement math — that lives in
 * @avidia/entitlements and the database.
 */

const payload: EntitlementsPayload = {
  rules_version: 1,
  plan: 'pro',
  enforced: true,
  capabilities: ['advanced_modes', 'study_planner'] as EntitlementsPayload['capabilities'],
  limits: { max_active_courses: null, monthly: { documents_processed: null } },
  usage: { documents_processed: 2 },
  period_key: '2026-08',
  subscriptions: [
    {
      provider: 'stripe',
      status: 'active',
      current_period_end: '2026-09-01T00:00:00Z',
      cancel_at_period_end: false,
      trial_end: null,
    },
  ],
  fetched_at: '2026-08-14T10:00:00.000Z',
};

function rpcClient(data: unknown, error: { message: string } | null = null): SupabaseClient {
  return { rpc: jest.fn(async () => ({ data, error })) } as unknown as SupabaseClient;
}

/**
 * deleteMyAccount() also lists the caller's own document storage keys and,
 * only after the RPC succeeds, removes them via the Storage API (spec AL —
 * see the comment on deleteMyAccount for why that ordering matters).
 */
function deletionClient(options: {
  docs?: Array<{ storage_key: string | null }>;
  rpcError?: { message: string } | null;
}): { client: SupabaseClient; removeMock: jest.Mock } {
  const removeMock = jest.fn(async () => ({ error: null }));
  const client = {
    rpc: jest.fn(async () => ({ data: null, error: options.rpcError ?? null })),
    from: jest.fn(() => ({
      select: jest.fn(async () => ({ data: options.docs ?? [], error: null })),
    })),
    storage: { from: jest.fn(() => ({ remove: removeMock })) },
  } as unknown as SupabaseClient;
  return { client, removeMock };
}

function functionsClient(result: {
  data?: unknown;
  error?: { context?: { status?: number } } | null;
}): SupabaseClient {
  return {
    functions: {
      invoke: jest.fn(async () => ({ data: result.data ?? null, error: result.error ?? null })),
    },
  } as unknown as SupabaseClient;
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('entitlement fetch + bounded cache trust (spec K/AW)', () => {
  it('fetches from the server and persists the payload as cache', async () => {
    const result = await fetchEntitlements(rpcClient(payload));
    expect(result.plan).toBe('pro');
    const cached = await readTrustedCache(new Date('2026-08-14T12:00:00Z'));
    expect(cached?.plan).toBe('pro');
  });

  it('trusts the cache only inside the 72h window — stale PRO is dropped', async () => {
    await fetchEntitlements(rpcClient(payload));
    expect(await readTrustedCache(new Date('2026-08-16T00:00:00Z'))).not.toBeNull();
    expect(await readTrustedCache(new Date('2026-08-20T00:00:00Z'))).toBeNull();
  });

  it('clearEntitlementsCache removes the persisted payload', async () => {
    await fetchEntitlements(rpcClient(payload));
    await clearEntitlementsCache();
    expect(await readTrustedCache(new Date('2026-08-14T12:00:00Z'))).toBeNull();
  });

  it('surfaces server errors instead of inventing entitlements', async () => {
    await expect(fetchEntitlements(rpcClient(null, { message: 'boom' }))).rejects.toBeTruthy();
  });
});

describe('client capability rendering (spec N — never authoritative)', () => {
  it('is permissive with no payload (server still enforces)', () => {
    expect(entitlementsAllow(null, 'advanced_modes')).toBe(true);
  });

  it('reflects the enforced plan for UI gating', () => {
    expect(entitlementsAllow({ ...payload, plan: 'free' }, 'advanced_modes')).toBe(false);
    expect(entitlementsAllow(payload, 'advanced_modes')).toBe(true);
    expect(entitlementsAllow({ ...payload, plan: 'free', enforced: false }, 'advanced_modes')).toBe(
      true
    );
  });
});

describe('Stripe hosted flows (spec E/R)', () => {
  it('returns the hosted checkout URL on success', async () => {
    const result = await startCheckout(functionsClient({ data: { url: 'https://stripe/c' } }));
    expect(result).toEqual({ status: 'ok', url: 'https://stripe/c' });
  });

  it('maps 503 to an honest not_configured outcome', async () => {
    const result = await startCheckout(functionsClient({ error: { context: { status: 503 } } }));
    expect(result.status).toBe('not_configured');
  });

  it('maps a missing billing account (404) for the portal', async () => {
    const result = await openBillingPortal(
      functionsClient({ error: { context: { status: 404 } } })
    );
    expect(result.status).toBe('no_billing_account');
  });

  it('never fabricates a URL on unknown errors', async () => {
    const result = await startCheckout(functionsClient({ error: {} }));
    expect(result.status).toBe('error');
  });
});

describe('store purchases stub (spec H/I/Q — case AY-H)', () => {
  it('the shipped adapter reports not-configured for purchase AND restore', async () => {
    expect(purchases.isConfigured()).toBe(false);
    expect((await purchases.purchasePro()).status).toBe('not_configured');
    expect((await purchases.restorePurchases()).status).toBe('not_configured');
  });
});

describe('account deletion guard (spec AL)', () => {
  it('reports success, removes the caller’s own storage objects, and clears the entitlement cache', async () => {
    await fetchEntitlements(rpcClient(payload));
    const { client, removeMock } = deletionClient({
      docs: [{ storage_key: 'u1/c1/d1/notes.pdf' }, { storage_key: null }],
    });
    const result = await deleteMyAccount(client);
    expect(result.status).toBe('deleted');
    // The null storage_key (a document whose upload never completed) is
    // filtered out rather than passed to the Storage API.
    expect(removeMock).toHaveBeenCalledWith(['u1/c1/d1/notes.pdf']);
    expect(await readTrustedCache(new Date('2026-08-14T12:00:00Z'))).toBeNull();
  });

  it('surfaces the active-subscription refusal distinctly and never touches storage', async () => {
    const { client, removeMock } = deletionClient({
      docs: [{ storage_key: 'u1/c1/d1/notes.pdf' }],
      rpcError: { message: 'ACTIVE_SUBSCRIPTION: cancel your subscription first' },
    });
    const result = await deleteMyAccount(client);
    expect(result.status).toBe('active_subscription');
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('other failures become a retryable error, not a silent success, and never touch storage', async () => {
    const { client, removeMock } = deletionClient({
      docs: [{ storage_key: 'u1/c1/d1/notes.pdf' }],
      rpcError: { message: 'network down' },
    });
    const result = await deleteMyAccount(client);
    expect(result.status).toBe('error');
    expect(removeMock).not.toHaveBeenCalled();
  });
});
