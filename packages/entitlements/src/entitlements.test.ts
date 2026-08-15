import {
  CAPABILITIES,
  PLAN_DEFINITIONS,
  monthlyPeriodKey,
  planHasCapability,
  withinLimit,
} from './plans';
import {
  PAST_DUE_GRACE_DAYS,
  grantsPaidAccess,
  normalizeStripeStatus,
  normalizeStoreState,
} from './status';
import { canUser, resolveEntitlements, shouldTrustCachedEntitlements } from './resolve';

/**
 * Plan/status/resolution tests — M14 (spec A/B/D/J/L/O/P/AW + billing cases
 * AY-A/B/E/F/G at the deterministic level; C/D/H live in webhook/store/authz
 * tests).
 */

const NOW = new Date('2026-08-14T12:00:00.000Z');

describe('plan model (spec A/B/L)', () => {
  it('defines exactly two plans, and PRO grants every capability', () => {
    expect(Object.keys(PLAN_DEFINITIONS).sort()).toEqual(['free', 'pro']);
    for (const capability of CAPABILITIES) {
      expect(planHasCapability('pro', capability)).toBe(true);
    }
  });

  it('FREE keeps the core loop useful: adaptive study is never paywalled', () => {
    expect(planHasCapability('free', 'adaptive_study')).toBe(true);
    expect(planHasCapability('free', 'course_uploads')).toBe(true);
    // Premium levers on FREE: advanced modes and planner.
    expect(planHasCapability('free', 'advanced_modes')).toBe(false);
    expect(planHasCapability('free', 'study_planner')).toBe(false);
  });

  it('FREE has finite limits; PRO limits are all unlimited (null)', () => {
    expect(PLAN_DEFINITIONS.free.limits.maxActiveCourses).toBe(1);
    for (const limit of Object.values(PLAN_DEFINITIONS.pro.limits.monthly)) {
      expect(limit).toBeNull();
    }
  });

  it('usage helpers: month key is UTC-stable and limits behave', () => {
    expect(monthlyPeriodKey(new Date('2026-08-31T23:59:59Z'))).toBe('2026-08');
    expect(monthlyPeriodKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
    expect(withinLimit(0, 1)).toBe(true);
    expect(withinLimit(1, 1)).toBe(false);
    expect(withinLimit(9999, null)).toBe(true);
  });
});

describe('status normalization (spec D/J)', () => {
  it('maps Stripe statuses to the five normalized states', () => {
    expect(normalizeStripeStatus('active')).toBe('active');
    expect(normalizeStripeStatus('trialing')).toBe('trialing');
    expect(normalizeStripeStatus('past_due')).toBe('past_due');
    expect(normalizeStripeStatus('unpaid')).toBe('past_due');
    expect(normalizeStripeStatus('canceled')).toBe('canceled');
    expect(normalizeStripeStatus('incomplete')).toBe('expired');
  });

  it('unknown provider vocabulary NEVER grants access', () => {
    expect(normalizeStripeStatus('some_future_status')).toBe('expired');
  });

  it('maps store entitlement states', () => {
    expect(normalizeStoreState({ isActive: true })).toBe('active');
    expect(normalizeStoreState({ isActive: true, isTrial: true })).toBe('trialing');
    expect(normalizeStoreState({ isActive: true, willRenew: false })).toBe('canceled');
    expect(normalizeStoreState({ isActive: false, isBillingRetry: true })).toBe('past_due');
    expect(normalizeStoreState({ isActive: false })).toBe('expired');
  });
});

describe('paid-access windows (spec P — cases E/F/G)', () => {
  const base = { provider: 'stripe', cancelAtPeriodEnd: false };

  it('active/trialing grant access through the period end', () => {
    const future = '2026-09-01T00:00:00.000Z';
    expect(grantsPaidAccess({ ...base, status: 'active', currentPeriodEnd: future }, NOW)).toBe(
      true
    );
    expect(grantsPaidAccess({ ...base, status: 'trialing', currentPeriodEnd: future }, NOW)).toBe(
      true
    );
  });

  it('CASE E: cancellation at period end keeps access through the paid period, then downgrades', () => {
    const sub = {
      ...base,
      status: 'canceled' as const,
      currentPeriodEnd: '2026-08-20T00:00:00.000Z',
      cancelAtPeriodEnd: true,
    };
    expect(grantsPaidAccess(sub, NOW)).toBe(true);
    expect(grantsPaidAccess(sub, new Date('2026-08-21T00:00:00.000Z'))).toBe(false);
  });

  it('CASE F: payment failure (past_due) grants a bounded grace window only', () => {
    const sub = {
      ...base,
      status: 'past_due' as const,
      currentPeriodEnd: '2026-08-10T00:00:00.000Z',
    };
    expect(grantsPaidAccess(sub, NOW)).toBe(true); // 4 days past end, inside grace
    const afterGrace = new Date(
      Date.parse(sub.currentPeriodEnd) + (PAST_DUE_GRACE_DAYS + 1) * 24 * 60 * 60 * 1000
    );
    expect(grantsPaidAccess(sub, afterGrace)).toBe(false);
  });

  it('CASE G: expired grants nothing', () => {
    expect(
      grantsPaidAccess(
        { ...base, status: 'expired', currentPeriodEnd: '2026-08-13T00:00:00.000Z' },
        NOW
      )
    ).toBe(false);
  });
});

describe('resolution across providers (spec J — cases A/B)', () => {
  it('CASE A: no subscriptions → FREE entitlements only', () => {
    const resolved = resolveEntitlements([], NOW);
    expect(resolved.plan).toBe('free');
    expect(resolved.source).toBeNull();
    expect(resolved.capabilities).toEqual(PLAN_DEFINITIONS.free.capabilities);
  });

  it('CASE B: one trusted active subscription → PRO, regardless of provider', () => {
    for (const provider of ['stripe', 'apple', 'google']) {
      const resolved = resolveEntitlements(
        [
          {
            provider,
            status: 'active',
            currentPeriodEnd: '2026-09-01T00:00:00.000Z',
            cancelAtPeriodEnd: false,
          },
        ],
        NOW
      );
      expect(resolved.plan).toBe('pro');
      expect(resolved.source).toBe(provider);
    }
  });

  it('an expired web sub plus an active store sub still resolves PRO (normalized, spec J)', () => {
    const resolved = resolveEntitlements(
      [
        { provider: 'stripe', status: 'expired', currentPeriodEnd: null, cancelAtPeriodEnd: false },
        {
          provider: 'apple',
          status: 'active',
          currentPeriodEnd: '2026-09-01T00:00:00.000Z',
          cancelAtPeriodEnd: false,
        },
      ],
      NOW
    );
    expect(resolved.plan).toBe('pro');
    expect(resolved.source).toBe('apple');
  });
});

describe('client capability check (spec K/N/AW)', () => {
  it('is permissive while the subscriptions flag is off (billing not live)', () => {
    expect(canUser({ plan: 'free', enforced: false }, 'patient_simulation')).toBe(true);
    expect(canUser(null, 'advanced_modes')).toBe(true);
  });

  it('reflects the plan once enforcement is live — and is never authoritative', () => {
    expect(canUser({ plan: 'free', enforced: true }, 'advanced_modes')).toBe(false);
    expect(canUser({ plan: 'pro', enforced: true }, 'advanced_modes')).toBe(true);
  });

  it('trusts a cached server payload for a bounded outage window only (spec AW)', () => {
    expect(shouldTrustCachedEntitlements('2026-08-14T00:00:00.000Z', NOW)).toBe(true);
    expect(shouldTrustCachedEntitlements('2026-08-01T00:00:00.000Z', NOW)).toBe(false);
    expect(shouldTrustCachedEntitlements('garbage', NOW)).toBe(false);
    // A cache "from the future" (clock tampering) is not trusted either.
    expect(shouldTrustCachedEntitlements('2026-09-01T00:00:00.000Z', NOW)).toBe(false);
  });
});
