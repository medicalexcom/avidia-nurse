import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';

import { env } from '../config/env';

/**
 * Supabase client factory.
 *
 * SECURITY: this file may only ever use the PUBLIC project URL and the PUBLIC
 * anon key (both EXPO_PUBLIC_*). All data access is enforced by row-level
 * security in the database. The service-role key is backend-only and must
 * never be imported, referenced, or bundled here.
 *
 * The client is `null` when Supabase is not configured (e.g. a fresh checkout
 * without a backend project). The auth layer treats that as "backend
 * unavailable" rather than crashing, so the repo always builds and runs.
 */

export function isSupabaseConfigured(): boolean {
  return Boolean(env.EXPO_PUBLIC_SUPABASE_URL && env.EXPO_PUBLIC_SUPABASE_ANON_KEY);
}

function buildClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) {
    return null;
  }
  return createClient(env.EXPO_PUBLIC_SUPABASE_URL!, env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: {
      // Native: persist the session in AsyncStorage so students stay signed in
      // across app restarts. Web: Supabase's default (localStorage) applies.
      ...(Platform.OS !== 'web' ? { storage: AsyncStorage } : {}),
      autoRefreshToken: true,
      persistSession: true,
      // Only the web build receives auth callbacks in the URL.
      detectSessionInUrl: Platform.OS === 'web',
    },
  });
}

let client: SupabaseClient | null | undefined;

/** Lazily-created singleton Supabase client (null when not configured). */
export function getSupabase(): SupabaseClient | null {
  if (client === undefined) {
    client = buildClient();
    if (client && Platform.OS !== 'web') {
      // Pause/resume token auto-refresh with the app lifecycle, per Supabase's
      // recommended React Native setup.
      AppState.addEventListener('change', (state) => {
        if (!client) return;
        if (state === 'active') {
          client.auth.startAutoRefresh();
        } else {
          client.auth.stopAutoRefresh();
        }
      });
    }
  }
  return client;
}

/** Test-only escape hatch: reset the singleton between tests. */
export function resetSupabaseForTesting(): void {
  client = undefined;
}
