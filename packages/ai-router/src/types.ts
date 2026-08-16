/**
 * Core vocabulary for the AI model router (v1).
 *
 * Tiers are capability/cost bands, not provider or model names (spec: "provider
 * names must not define the tiers"). Today every tier resolves to an OpenAI
 * model (see openai.ts), but a task or screen only ever asks for a TIER via a
 * TASK — never a concrete model — so swapping or adding a provider later is a
 * config change in one file, not a call-site rewrite.
 */

/**
 * SPECIALIZED   — task-specific models that are not general chat/reasoning
 *                 models (embeddings today; transcription/vision/etc. later).
 *                 Never substitutable with a chat-tier model.
 * ECONOMY       — cheapest capable tier: high-volume, structured, validated
 *                 downstream (concept extraction, routine question generation,
 *                 basic explanations).
 * STANDARD      — mid tier: retrieval-grounded answers, complex question
 *                 generation, default simulation dialogue.
 * ADVANCED      — highest tier: deep tutoring, clinical-reasoning evaluation,
 *                 simulation case authoring — quality/reasoning matters more
 *                 than cost, and this tier must never be silently downgraded.
 */
export const AI_TIERS = ['SPECIALIZED', 'ECONOMY', 'STANDARD', 'ADVANCED'] as const;
export type AiTier = (typeof AI_TIERS)[number];

/** Relative capability ordering among the three general chat tiers (SPECIALIZED is not on this ladder — it is never a fallback target for a chat task, and a chat tier is never a fallback target for a SPECIALIZED task). */
export const CHAT_TIER_RANK: Record<Exclude<AiTier, 'SPECIALIZED'>, number> = {
  ECONOMY: 0,
  STANDARD: 1,
  ADVANCED: 2,
};

export const AI_COMPLEXITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type AiComplexity = (typeof AI_COMPLEXITIES)[number];

/**
 * Every real or planned AI call site in the product, named by what it DOES,
 * not by who calls it (spec section 2/5). Only EMBEDDING, CONCEPT_EXTRACTION
 * and QUESTION_GENERATION_ROUTINE have a live caller today (M5/M6/M7); the
 * rest are routed and tested now so future features (tutoring, RAG answers,
 * simulation authoring) never need to invent their own model selection.
 */
export const AI_TASKS = [
  'EMBEDDING',
  'CONCEPT_EXTRACTION',
  'QUESTION_GENERATION_ROUTINE',
  'QUESTION_GENERATION_COMPLEX',
  'QUESTION_REPAIR',
  'RAG_ANSWER',
  'BASIC_EXPLANATION',
  'DEEP_TUTORING',
  'CLINICAL_REASONING_EVALUATION',
  'CASE_STUDY_GENERATION',
  'SIMULATION_CASE_GENERATION',
  'SIMULATION_DIALOGUE',
] as const;
export type AiTask = (typeof AI_TASKS)[number];

/**
 * Extra routing input beyond task + complexity. All optional: a bare
 * `routeAiTask({task: 'CONCEPT_EXTRACTION', complexity: 'MEDIUM'})` always
 * resolves.
 */
export interface AiTaskRequirements {
  /** True (default) when the caller needs strict JSON-schema structured output. */
  structuredOutput?: boolean;
  /**
   * Never resolve (as primary OR fallback) below this tier. Used by
   * QUESTION_REPAIR to stay at least as capable as the request being
   * repaired, and by callers that already know a task turned out to need
   * more than its default tier.
   */
  minTier?: AiTier;
  /**
   * When false, this task will never receive a fallback suggestion — a
   * failure is a failure, surfaced as-is. Defaults to true. SPECIALIZED
   * (embedding) tasks ignore this: there is only one embedding model,
   * because a different embedding model produces vectors that are not
   * comparable to what is already stored (spec ADR-0012).
   */
  allowFallback?: boolean;
}

export interface AiModelChoice {
  /** Provider identifier, e.g. "openai". Never a brand string baked into a tier name. */
  provider: string;
  /** Concrete model id for that provider, e.g. "gpt-5-mini". */
  model: string;
  tier: AiTier;
}

export interface AiRouteResult extends AiModelChoice {
  /**
   * The next model to try if this one fails after its own retries are
   * exhausted (429/5xx/timeout/quota) — always same-or-higher tier, never a
   * downgrade. `null` when there is nowhere safe to go (already the top
   * tier, or the task disallows fallback, or only one model exists for the
   * task, as with EMBEDDING).
   */
  fallback: AiModelChoice | null;
}

export interface AiTaskRequest {
  task: AiTask;
  complexity: AiComplexity;
  requirements?: AiTaskRequirements;
}
