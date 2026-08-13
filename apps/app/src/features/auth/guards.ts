/**
 * Pure protected-route decision logic, kept free of React/router imports so it
 * is directly unit-testable. The root layout applies these decisions with
 * expo-router.
 */

export type AuthStatus =
  | 'restoring' // reading persisted session at startup
  | 'signed-in'
  | 'signed-out'
  | 'unavailable'; // Supabase not configured / unreachable at startup

export type RouteGroup = 'auth' | 'app' | 'other';

/** Map expo-router segments (e.g. ['(app)', 'profile']) to a route group. */
export function routeGroupFromSegments(segments: readonly string[]): RouteGroup {
  if (segments[0] === '(auth)') return 'auth';
  if (segments[0] === '(app)') return 'app';
  return 'other';
}

export type GuardDecision =
  | { action: 'stay' }
  | { action: 'show-loading' }
  | { action: 'redirect'; to: '/sign-in' | '/home' };

/**
 * Decide what to do for a given auth status and current route group.
 *
 * Rules:
 * - While restoring the persisted session, show a loading state (never flash
 *   the sign-in screen at a signed-in user, and never expose the shell early).
 * - Unauthenticated (or backend unavailable) users may not enter '(app)'.
 * - Signed-in users are moved out of the auth screens into the shell.
 */
export function decideRoute(status: AuthStatus, group: RouteGroup): GuardDecision {
  if (status === 'restoring') {
    return { action: 'show-loading' };
  }
  if (status === 'signed-in') {
    if (group === 'auth' || group === 'other') return { action: 'redirect', to: '/home' };
    return { action: 'stay' };
  }
  // signed-out or unavailable
  if (group === 'app' || group === 'other') return { action: 'redirect', to: '/sign-in' };
  return { action: 'stay' };
}
