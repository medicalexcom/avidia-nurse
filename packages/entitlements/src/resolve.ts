/**
 * Entitlement resolution — M14 (spec B/J/K/AW).
 *
 * One function turns trusted subscription rows (from ANY provider) into the
 * normalized entitlement payload the rest of the product consumes. The same
 * rules are mirrored by the SQL `current_plan` function — the database is the
 * authority; this pure version powers tests and client rendering of
 * server-fetched state.
 */

import {
  PLAN_DEFINITIONS,
  planHasCapability,
  type Capability,
  type Plan,
  type PlanLimits,
} from './plans';
import { grantsPaidAccess, type SubscriptionLike } from './status';

export interface ResolvedEntitlements {
  plan: Plan;
  capabilities: readonly Capability[];
  limits: PlanLimits;
  /** Which subscription granted PRO, if any (provider name for display). */
  source: string | null;
}

/**
 * Resolve the user's plan from ALL subscription rows across providers
 * (spec J): any single row that grants paid access at `now` yields PRO —
 * a student who bought on the web and reinstalled on iOS keeps access.
 * No rows, or none granting access, yields FREE. Learning data is NEVER
 * part of this computation — expiration changes gating, not data (spec O).
 */
export function resolveEntitlements(
  subscriptions: readonly SubscriptionLike[],
  now: Date
): ResolvedEntitlements {
  const granting = subscriptions.find((subscription) => grantsPaidAccess(subscription, now));
  const plan: Plan = granting ? 'pro' : 'free';
  const definition = PLAN_DEFINITIONS[plan];
  return {
    plan,
    capabilities: definition.capabilities,
    limits: definition.limits,
    source: granting ? String(granting.provider) : null,
  };
}

/**
 * Client-side capability check (spec K/N). NOT authoritative: the server
 * enforces entitlements on paid operations regardless of what the client
 * believes. `enforced=false` (the `subscriptions_enforced` feature flag is
 * off) means billing is not live yet — everything renders unlocked.
 */
export function canUser(
  entitlements: { plan: Plan; enforced: boolean } | null,
  capability: Capability
): boolean {
  if (!entitlements || !entitlements.enforced) return true;
  return planHasCapability(entitlements.plan, capability);
}

/**
 * Cache trust window for provider/backend outages (spec AW): keep rendering
 * the last server-confirmed entitlements for up to this long rather than
 * instantly revoking a paying student's UI. The server remains authoritative
 * for every paid operation throughout, so a forged/stale cache can style the
 * UI but never unlock server-gated work. Beyond the window, fall back to
 * FREE rendering until a refresh succeeds.
 */
export const ENTITLEMENT_CACHE_TRUST_HOURS = 72;

export function shouldTrustCachedEntitlements(fetchedAtIso: string, now: Date): boolean {
  const fetchedAt = Date.parse(fetchedAtIso);
  if (Number.isNaN(fetchedAt)) return false;
  const ageHours = (now.getTime() - fetchedAt) / (60 * 60 * 1000);
  return ageHours >= 0 && ageHours <= ENTITLEMENT_CACHE_TRUST_HOURS;
}
