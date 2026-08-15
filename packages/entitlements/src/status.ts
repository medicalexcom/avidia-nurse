/**
 * Subscription status normalization — M14 (spec D/J/P).
 *
 * Provider-specific lifecycle vocabulary (Stripe statuses, store entitlement
 * states) is normalized HERE, once, into five trusted states. Nothing else in
 * Avidia Nurse understands Stripe vs Apple vs Google.
 */

export const SUBSCRIPTION_PROVIDERS = ['stripe', 'apple', 'google'] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

export const SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'canceled',
  'expired',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * Days of continued access after a payment failure (`past_due`) while the
 * provider retries (spec P/AW). Documented tradeoff: a short dunning window
 * beats instantly locking out a student whose card expired mid-semester;
 * `expired`/`canceled` past period end never grant access.
 */
export const PAST_DUE_GRACE_DAYS = 7;

/**
 * Map a raw Stripe subscription status to the normalized model (spec D).
 * Unknown/future statuses map to 'expired' — the SAFE direction: never grant
 * paid access on vocabulary we do not recognize.
 */
export function normalizeStripeStatus(raw: string): SubscriptionStatus {
  switch (raw) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    case 'incomplete':
    case 'incomplete_expired':
    case 'paused':
    default:
      return 'expired';
  }
}

/**
 * Map a store-abstraction (RevenueCat-style) entitlement state to the
 * normalized model. The store layer reports whether the entitlement is
 * active, in trial, in billing retry, or gone.
 */
export function normalizeStoreState(raw: {
  isActive: boolean;
  isTrial?: boolean;
  isBillingRetry?: boolean;
  willRenew?: boolean;
}): SubscriptionStatus {
  if (raw.isBillingRetry) return 'past_due';
  if (!raw.isActive) return 'expired';
  if (raw.isTrial) return 'trialing';
  if (raw.willRenew === false) return 'canceled';
  return 'active';
}

export interface SubscriptionLike {
  provider: SubscriptionProvider | string;
  status: SubscriptionStatus | string;
  /** ISO timestamp of the paid period end; null when unknown. */
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether one subscription row grants paid access at `now` (spec D/O/P):
 *  - active/trialing → yes through period end (period end null = trust status)
 *  - past_due → yes through period end + grace window (dunning)
 *  - canceled → yes through the already-paid period end, then no
 *  - expired/unknown → no
 */
export function grantsPaidAccess(subscription: SubscriptionLike, now: Date): boolean {
  const end = subscription.currentPeriodEnd ? Date.parse(subscription.currentPeriodEnd) : null;
  const at = now.getTime();
  switch (subscription.status) {
    case 'active':
    case 'trialing':
      return end === null || at <= end;
    case 'past_due':
      return end !== null && at <= end + PAST_DUE_GRACE_DAYS * DAY_MS;
    case 'canceled':
      return end !== null && at <= end;
    default:
      return false;
  }
}
