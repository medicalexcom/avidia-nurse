/**
 * User-safe authentication error mapping.
 *
 * Raw provider errors must never be shown to students: they can leak
 * implementation details and are often confusing. Every auth failure funnels
 * through mapAuthError, which returns a short, plain-language message.
 */

export type AuthErrorKind =
  | 'invalid-credentials'
  | 'duplicate-account'
  | 'weak-password'
  | 'invalid-email'
  | 'expired-session'
  | 'network'
  | 'backend-unavailable'
  | 'unknown';

export interface UserSafeAuthError {
  kind: AuthErrorKind;
  message: string;
}

const MESSAGES: Record<AuthErrorKind, string> = {
  'invalid-credentials': 'That email and password combination is incorrect. Please try again.',
  'duplicate-account': 'An account with this email already exists. Try signing in instead.',
  'weak-password': 'Please choose a longer password (at least 8 characters).',
  'invalid-email': 'That does not look like a valid email address.',
  'expired-session': 'Your session has expired. Please sign in again.',
  network: 'We could not reach the server. Check your connection and try again.',
  'backend-unavailable':
    'Sign-in is not available right now. Please try again later or contact support.',
  unknown: 'Something went wrong. Please try again.',
};

export function authErrorFor(kind: AuthErrorKind): UserSafeAuthError {
  return { kind, message: MESSAGES[kind] };
}

/** Classify an unknown thrown value / Supabase AuthError into a safe error. */
export function mapAuthError(error: unknown): UserSafeAuthError {
  if (!error) return authErrorFor('unknown');

  const err = error as { message?: string; status?: number; code?: string; name?: string };
  const message = (err.message ?? String(error)).toLowerCase();
  const code = err.code ?? '';

  if (
    err.name === 'AuthRetryableFetchError' ||
    message.includes('network') ||
    message.includes('failed to fetch') ||
    message.includes('fetch failed') ||
    message.includes('timeout')
  ) {
    return authErrorFor('network');
  }
  if (code === 'invalid_credentials' || message.includes('invalid login credentials')) {
    return authErrorFor('invalid-credentials');
  }
  if (
    code === 'user_already_exists' ||
    code === 'email_exists' ||
    message.includes('already registered') ||
    message.includes('already exists')
  ) {
    return authErrorFor('duplicate-account');
  }
  if (code === 'weak_password' || message.includes('password should be at least')) {
    return authErrorFor('weak-password');
  }
  if (code === 'validation_failed' || message.includes('invalid email')) {
    return authErrorFor('invalid-email');
  }
  if (
    code === 'session_expired' ||
    code === 'refresh_token_not_found' ||
    message.includes('refresh token') ||
    message.includes('session expired') ||
    message.includes('jwt expired')
  ) {
    return authErrorFor('expired-session');
  }
  if (typeof err.status === 'number' && err.status >= 500) {
    return authErrorFor('backend-unavailable');
  }
  return authErrorFor('unknown');
}
