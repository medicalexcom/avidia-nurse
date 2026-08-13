import { validateClientEnv, type ClientEnv } from '@avidia/config';

/**
 * Validated, typed client environment. Expo inlines EXPO_PUBLIC_* variables at
 * build time, so each one must be referenced statically (not via dynamic
 * process.env lookups).
 *
 * Validation happens at module load: a misconfigured build fails fast with a
 * readable error instead of silently running with bad configuration.
 */
export const env: ClientEnv = validateClientEnv({
  EXPO_PUBLIC_APP_ENV: process.env.EXPO_PUBLIC_APP_ENV,
  EXPO_PUBLIC_API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL,
  EXPO_PUBLIC_WEB_APP_URL: process.env.EXPO_PUBLIC_WEB_APP_URL,
  EXPO_PUBLIC_ANALYTICS_KEY: process.env.EXPO_PUBLIC_ANALYTICS_KEY,
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
});
