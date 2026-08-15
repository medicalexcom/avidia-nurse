export {
  ENTITLEMENTS_RULES_VERSION,
  PLANS,
  CAPABILITIES,
  USAGE_RESOURCES,
  PLAN_DEFINITIONS,
  planHasCapability,
  monthlyPeriodKey,
  withinLimit,
} from './plans';
export type { Plan, Capability, UsageResource, PlanLimits, PlanDefinition } from './plans';

export {
  SUBSCRIPTION_PROVIDERS,
  SUBSCRIPTION_STATUSES,
  PAST_DUE_GRACE_DAYS,
  normalizeStripeStatus,
  normalizeStoreState,
  grantsPaidAccess,
} from './status';
export type { SubscriptionProvider, SubscriptionStatus, SubscriptionLike } from './status';

export {
  resolveEntitlements,
  canUser,
  ENTITLEMENT_CACHE_TRUST_HOURS,
  shouldTrustCachedEntitlements,
} from './resolve';
export type { ResolvedEntitlements } from './resolve';

export {
  HANDLED_STRIPE_EVENTS,
  isHandledStripeEvent,
  snapshotFromStripeSubscription,
  shouldProcessEvent,
} from './webhook';
export type { SubscriptionSnapshot } from './webhook';

export { notConfiguredPurchases, STORE_NOT_CONFIGURED_REASON } from './store';
export type { StorePurchasesAdapter, PurchaseOutcome, RestoreOutcome } from './store';
