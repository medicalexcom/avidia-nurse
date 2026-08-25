/**
 * Password-recovery link detection & redirect-URL construction.
 *
 * Kept pure and platform-parameterized (same discipline as guards.ts) so it
 * is directly unit-testable without a DOM or React Native runtime.
 */

/**
 * Does this URL look like a Supabase password-recovery callback?
 *
 * Supabase appends `type=recovery` to whatever `redirectTo` URL we pass
 * `resetPasswordForEmail`, either as a query param or inside the URL
 * fragment depending on auth flow/platform. A single regex across the whole
 * string catches both shapes, plus the custom-scheme deep link native uses,
 * without needing a URL parser that understands non-http(s) schemes.
 */
export function isPasswordRecoveryUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /[?&#]type=recovery(?:&|$)/.test(url);
}

export interface RecoveryRedirectOptions {
  /** `Platform.OS` — only `'web'` uses the http(s) branch below. */
  platform: 'web' | 'ios' | 'android' | 'windows' | 'macos';
  /**
   * `EXPO_PUBLIC_WEB_APP_URL`, when configured. Required for any web build
   * served from a sub-path (e.g. GitHub Pages' `/avidia-nurse`) — there is
   * no reliable way to recover a base path from `window.location` alone.
   */
  webAppUrl?: string;
  /** `window.location.origin`, when available (web only). */
  windowOrigin?: string;
  /** Builds the native deep link, e.g. `Linking.createURL('reset-password')`. */
  createNativeUrl: () => string;
}

/** Where `resetPasswordForEmail` should send the student back to. */
export function buildRecoveryRedirectUrl(options: RecoveryRedirectOptions): string {
  if (options.platform !== 'web') {
    return options.createNativeUrl();
  }
  const base = options.webAppUrl ?? options.windowOrigin;
  if (!base) return '/reset-password';
  return `${base.replace(/\/+$/, '')}/reset-password`;
}
