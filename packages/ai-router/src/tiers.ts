import { AiComplexity, AiTask, AiTier } from './types';

/**
 * Provider-independent task -> tier mapping (spec section 3's "initial
 * intent" list). This is the ONLY place that decides which tier a task
 * runs at; everything downstream (router.ts, config.ts, openai.ts) just
 * resolves a tier to a concrete model.
 */

/** Tasks whose tier never changes with complexity. */
const FIXED_TIER: Partial<Record<AiTask, Exclude<AiTier, 'SPECIALIZED'>>> = {
  CONCEPT_EXTRACTION: 'ECONOMY',
  QUESTION_GENERATION_ROUTINE: 'ECONOMY',
  QUESTION_GENERATION_COMPLEX: 'STANDARD',
  BASIC_EXPLANATION: 'ECONOMY',
  RAG_ANSWER: 'STANDARD',
  DEEP_TUTORING: 'ADVANCED',
  CLINICAL_REASONING_EVALUATION: 'ADVANCED',
  SIMULATION_CASE_GENERATION: 'ADVANCED',
  SIMULATION_DIALOGUE: 'STANDARD',
};

/**
 * Base tier for a task, before any per-call override (requirements.minTier,
 * QUESTION_REPAIR's "same tier as what it's repairing"). EMBEDDING is
 * SPECIALIZED and is never resolved through this function — see router.ts.
 */
export function baseTierForTask(task: AiTask, complexity: AiComplexity): Exclude<AiTier, 'SPECIALIZED'> {
  if (task === 'EMBEDDING') {
    throw new Error('EMBEDDING is a SPECIALIZED task; use resolveEmbeddingModel(), not baseTierForTask().');
  }
  const fixed = FIXED_TIER[task];
  if (fixed) {
    return fixed;
  }
  // CASE_STUDY_GENERATION: "STANDARD / ADVANCED by complexity" (spec).
  if (task === 'CASE_STUDY_GENERATION') {
    return complexity === 'HIGH' ? 'ADVANCED' : 'STANDARD';
  }
  // QUESTION_REPAIR: caller supplies the originating tier via
  // requirements.minTier; router.ts floors on that. If none was supplied
  // (a repair requested with no context), default to the same complexity
  // rule as a fresh routine question generation — never higher without a
  // reason, per "escalate only if necessary."
  if (task === 'QUESTION_REPAIR') {
    return 'ECONOMY';
  }
  // Exhaustive by construction (AI_TASKS union) — TypeScript will flag any
  // task added to types.ts without a mapping added here.
  const exhaustiveCheck: never = task as never;
  throw new Error(`No tier mapping for task "${String(exhaustiveCheck)}".`);
}
