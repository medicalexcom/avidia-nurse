import { useCallback, useEffect, useState } from 'react';

import { getSupabase } from '../../lib/supabase';
import { fetchEntitlements, readTrustedCache, type EntitlementsPayload } from './billingApi';

/**
 * Entitlements hook (spec K/N/AW).
 *
 * Fetches the server-authoritative payload; on failure falls back to the
 * bounded-trust cache. `entitlements === null` (no server answer, no valid
 * cache) renders PERMISSIVELY for UI purposes — the server still enforces
 * real limits, so failing open in the UI can never grant anything that
 * matters, while failing closed would lock paying students out of premium
 * features during an outage (documented tradeoff, ADR-0037).
 */
export function useEntitlements(): {
  entitlements: EntitlementsPayload | null;
  loading: boolean;
  fromCache: boolean;
  refresh: () => Promise<void>;
} {
  const [entitlements, setEntitlements] = useState<EntitlementsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [fromCache, setFromCache] = useState(false);

  const refresh = useCallback(async () => {
    const client = getSupabase();
    if (!client) {
      setLoading(false);
      return;
    }
    try {
      const payload = await fetchEntitlements(client);
      setEntitlements(payload);
      setFromCache(false);
    } catch {
      const cached = await readTrustedCache();
      setEntitlements(cached);
      setFromCache(cached !== null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { entitlements, loading, fromCache, refresh };
}
