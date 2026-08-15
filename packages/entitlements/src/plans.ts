/**
 * Plan and capability model — M14 (spec A/B/L).
 *
 * Two plans only (FREE and PRO), per the instruction not to create excessive
 * pricing tiers; the blueprint's Student / AI Pro / Annual split is a pricing
 * HYPOTHESIS that can be layered on later precisely because the application
 * asks about CAPABILITIES, never `user.plan === 'pro'`.
 *
 * IMPORTANT (spec L): the FREE limits below are engineering placeholders that
 * follow the blueprint's "one active course, limited AI/simulation, basic
 * review" positioning. Final business limits/pricing require founder
 * approval — change them HERE (and in migration seed values), nowhere else.
 */

export const ENTITLEMENTS_RULES_VERSION = 1;

export const PLANS = ['free', 'pro'] as const;
export type Plan = (typeof PLANS)[number];

/**
 * Capabilities mirror ACTUAL implemented functionality (M3–M13). The UI and
 * server ask `canUser('patient_simulation')`, never `plan === 'pro'`.
 */
export const CAPABILITIES = [
  /** Create courses and upload course material (M2/M3) — limited on FREE. */
  'course_uploads',
  /** Daily adaptive study sessions (M9) — the core loop, never fully paywalled. */
  'adaptive_study',
  /** The five M10 advanced study modes. */
  'advanced_modes',
  /** M11 stateful patient simulations — usage-limited on FREE. */
  'patient_simulation',
  /** M12 analytics and readiness page. */
  'analytics',
  /** M13 study planner and reminders. */
  'study_planner',
  /** AI-powered processing/generation (uploads → concepts/questions) — usage-limited on FREE. */
  'ai_generation',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Metered resources tracked server-side (spec W/X). Counters are recorded for
 * ALL plans (cost telemetry); LIMITS are enforced only for plans that define
 * one and only while the `subscriptions_enforced` feature flag is on.
 */
export const USAGE_RESOURCES = ['documents_processed', 'ai_generations', 'simulations'] as const;
export type UsageResource = (typeof USAGE_RESOURCES)[number];

export interface PlanLimits {
  /** Maximum simultaneously ACTIVE courses; null = unlimited. */
  maxActiveCourses: number | null;
  /** Per-calendar-month (UTC) caps; null = unlimited. */
  monthly: Record<UsageResource, number | null>;
}

export interface PlanDefinition {
  plan: Plan;
  capabilities: readonly Capability[];
  limits: PlanLimits;
}

/**
 * FREE keeps the product genuinely useful (spec L): the full adaptive loop,
 * one active course with limited uploads/AI, limited simulations, and basic
 * progress. PRO removes the limits and unlocks advanced modes + planner.
 */
export const PLAN_DEFINITIONS: Record<Plan, PlanDefinition> = {
  free: {
    plan: 'free',
    capabilities: [
      'course_uploads',
      'adaptive_study',
      'patient_simulation',
      'analytics',
      'ai_generation',
    ],
    limits: {
      maxActiveCourses: 1,
      monthly: { documents_processed: 10, ai_generations: 30, simulations: 3 },
    },
  },
  pro: {
    plan: 'pro',
    capabilities: [...CAPABILITIES],
    limits: {
      maxActiveCourses: null,
      monthly: { documents_processed: null, ai_generations: null, simulations: null },
    },
  },
};

export function planHasCapability(plan: Plan, capability: Capability): boolean {
  return PLAN_DEFINITIONS[plan].capabilities.includes(capability);
}

/** UTC calendar-month key ('2026-08') for server usage counters (spec X). */
export function monthlyPeriodKey(now: Date): string {
  const year = now.getUTCFullYear();
  const month = `${now.getUTCMonth() + 1}`.padStart(2, '0');
  return `${year}-${month}`;
}

/** True when another unit of usage is allowed under the limit (null = unlimited). */
export function withinLimit(currentCount: number, limit: number | null): boolean {
  if (limit === null) return true;
  return currentCount < limit;
}
