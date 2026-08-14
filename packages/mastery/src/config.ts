/**
 * Centralized adaptive-engine configuration — M8 (spec AJ/O/F/G/H/I/K/Q).
 *
 * EVERY weight, threshold, interval and cap of the mastery engine lives in
 * this file, versioned as MASTERY_ALGORITHM_VERSION. Nothing elsewhere in
 * the engine hard-codes a number. Changing behavior means changing THIS
 * file and bumping the version (spec AA) — historical mastery_events record
 * which version produced them, so recomputation strategies stay possible.
 *
 * The SQL implementation inside `submit_question_attempt` (migration 0008)
 * mirrors these constants literally; the contract tests in update.test.ts
 * pin the semantics so drift in either implementation breaks CI.
 */

import type { CognitiveLevel, ConfidenceLevel, QuestionDifficulty } from '@avidia/domain';

/**
 * Version of the mastery-update algorithm (spec AA). Stored on every
 * mastery event. Migration strategy (documented, ADR-0022): a version bump
 * either (a) applies only to new events, leaving old aggregates in place, or
 * (b) recomputes aggregates from the immutable attempt history offline —
 * possible because attempts are the ground truth and the update function is
 * pure and versioned.
 */
export const MASTERY_ALGORITHM_VERSION = 1;

/** Mastery is a normalized signal in [0, 1] (spec B). */
export const MASTERY_MIN = 0;
export const MASTERY_MAX = 1;

/**
 * Base learning/decay rates (spec E: repeated performance matters — the
 * gain shrinks as mastery approaches 1, so one lucky answer can never claim
 * mastery; several consistent ones are needed).
 *
 * Correct:   m' = m + min(GAIN_RATE × w × (1 − m), GAIN_CAP)
 * Incorrect: m' = m − min(DROP_RATE × w × max(m, DROP_FLOOR), DROP_CAP)
 *
 * where w is the combined evidence weight (difficulty × cognitive ×
 * confidence × response-time factors below), clamped to WEIGHT_RANGE.
 */
export const GAIN_RATE = 0.3;
export const DROP_RATE = 0.4;
/** Per-answer movement caps (spec AK invariant: bounded single-step effect). */
export const GAIN_CAP = 0.25;
export const DROP_CAP = 0.3;
/**
 * An incorrect answer at very low mastery still moves the needle a little
 * (there is information in being wrong), hence the floor inside the drop
 * term.
 */
export const DROP_FLOOR = 0.35;
/** Combined evidence weight is clamped to this range (bounded influence). */
export const WEIGHT_RANGE = { min: 0.25, max: 2.0 } as const;

/**
 * Difficulty weighting (spec F — transparent and documented):
 * a correct HARD answer is stronger evidence of mastery than a correct easy
 * one; an incorrect EASY answer is stronger evidence of a gap than an
 * incorrect hard one. Difficulty is coarse AI-estimated metadata (M7 spec F)
 * so the spread is deliberately modest.
 */
export const DIFFICULTY_WEIGHT_CORRECT: Record<QuestionDifficulty, number> = {
  easy: 0.8,
  moderate: 1.0,
  hard: 1.25,
};
export const DIFFICULTY_WEIGHT_INCORRECT: Record<QuestionDifficulty, number> = {
  easy: 1.25,
  moderate: 1.0,
  hard: 0.8,
};

/**
 * Cognitive-level weighting (spec G — one signal, not psychometrics):
 * correct answers at application/analysis/prioritization demonstrate
 * transfer and count somewhat more; recall a bit less. Incorrect answers are
 * NOT amplified by level — missing an analysis question is not stronger gap
 * evidence than missing a recall question about the same concept.
 */
export const COGNITIVE_WEIGHT_CORRECT: Record<CognitiveLevel, number> = {
  recall: 0.85,
  understanding: 0.95,
  application: 1.1,
  analysis: 1.2,
  prioritization: 1.25,
};
export const COGNITIVE_WEIGHT_INCORRECT = 1.0;

/**
 * Confidence calibration (spec H). Confidence is optional self-report; null
 * is neutral. The rules encode:
 *   - correct + certain      → slightly stronger mastery evidence
 *   - correct + guessing     → much weaker (lucky guess ≠ knowledge)
 *   - incorrect + certain    → stronger gap evidence (misconception signal)
 *   - incorrect + guessing   → softer drop — the student KNEW they didn't
 *                              know; reporting uncertainty is never punished
 *                              relative to a confident error (spec H).
 */
export const CONFIDENCE_WEIGHT_CORRECT: Record<ConfidenceLevel, number> = {
  guessing: 0.55,
  unsure: 0.8,
  pretty_sure: 1.0,
  certain: 1.1,
};
export const CONFIDENCE_WEIGHT_INCORRECT: Record<ConfidenceLevel, number> = {
  guessing: 0.85,
  unsure: 0.9,
  pretty_sure: 1.05,
  certain: 1.15,
};
export const CONFIDENCE_WEIGHT_NEUTRAL = 1.0;

/**
 * Response time (spec I): EXCLUDED from the v1 update — factor fixed at 1.0.
 * Rationale (documented per spec I): response time confounds reading speed,
 * accessibility needs, interruptions and network conditions with knowledge;
 * we store it (M7) but do not let it move mastery until there is evidence it
 * helps. The constant exists so the formula shape is stable when v2 revisits
 * this.
 */
export const RESPONSE_TIME_FACTOR = 1.0;

/**
 * Misconception severity (spec R): accumulated from confident-incorrect
 * answers, decayed by correct ones, clamped to [0, 1]. At or above
 * MISCONCEPTION_SIGNAL_THRESHOLD the concept carries a misconception signal
 * (a flag for emphasis — never an AI diagnosis in M8).
 */
export const MISCONCEPTION_INCREMENT = {
  certain: 0.3,
  pretty_sure: 0.2,
  other_incorrect: 0.1,
} as const;
export const MISCONCEPTION_DECAY_ON_CORRECT = 0.5; // multiplied in
export const MISCONCEPTION_SIGNAL_THRESHOLD = 0.5;

/**
 * Spaced-review intervals (spec K — explainable, tuned to nursing course
 * rhythms, not blind SM-2). Hours: 1 day, 3 days, 7 days, 14 days, 30 days —
 * mirroring the study-pattern in the course-design source docs (Day 1 quick
 * retrieval, Day 3 application, Day 7 mixed, Day 14 cumulative).
 *
 * A correct answer advances one stage (unless confidence was 'guessing' —
 * a lucky guess earns no schedule relief); an incorrect answer resets to
 * stage 0. The stage indexes into this array; beyond the last entry the last
 * interval repeats.
 */
export const REVIEW_INTERVALS_HOURS = [24, 72, 168, 336, 720] as const;

/**
 * Mastery-state thresholds (spec Q — centralized, adjustable):
 *   mastery <  NEEDS_REVIEW_BELOW           → needs_review
 *   mastery <  STRONG_AT (and ≥ the above)  → developing
 *   mastery ≥  STRONG_AT                    → strong
 * due_for_review overlays any assessed state when now ≥ next_review_at;
 * unassessed = no evidence row at all (spec C).
 */
export const STATE_THRESHOLDS = {
  NEEDS_REVIEW_BELOW: 0.4,
  STRONG_AT: 0.75,
} as const;

/**
 * Priority model factors (spec O — deterministic, documented, centralized;
 * priority ≈ examRelevance × weakness × forgettingRisk × emphasisFactor ×
 * misconceptionMultiplier × transferNeed, each factor bounded).
 */
export const PRIORITY = {
  /** weakness = 1 − WEAKNESS_MASTERY_SCALE × mastery (so even strong
   * concepts keep a small floor of attention rather than reaching zero). */
  WEAKNESS_MASTERY_SCALE: 0.85,
  /** examRelevance = 1 + EXAM_URGENCY_SCALE × urgency for in-scope concepts;
   * 1.0 when no exam applies. */
  EXAM_URGENCY_SCALE: 1.5,
  /** emphasisFactor = 1 + EMPHASIS_SCALE × normalizedEmphasis (spec N:
   * bounded — emphasis can boost, never dominate). */
  EMPHASIS_SCALE: 0.5,
  /** misconceptionMultiplier = 1 + misconception_severity (≤ 2). */
  /** transferNeed bonus when mastery is developing+ but all correct
   * evidence sits at recall/understanding. */
  TRANSFER_NEED_BONUS: 1.25,
  /** Defaults for unassessed concepts (spec X cold start: important
   * unassessed material surfaces early but does not swamp known gaps). */
  UNASSESSED_WEAKNESS: 1.0,
  UNASSESSED_FORGETTING_RISK: 0.6,
  /** Forgetting-risk floor for recently reviewed, not-yet-due concepts. */
  FORGETTING_RISK_FLOOR: 0.15,
} as const;

/**
 * Exam-urgency steps by calendar days until the exam in the student's
 * timezone (spec L/AI). Deterministic lookup, no decay curve pretending
 * precision. Past exams contribute nothing.
 */
export const EXAM_URGENCY_STEPS: ReadonlyArray<{ maxDays: number; urgency: number }> = [
  { maxDays: 0, urgency: 1.0 }, // exam today
  { maxDays: 1, urgency: 0.95 }, // tomorrow
  { maxDays: 3, urgency: 0.8 },
  { maxDays: 7, urgency: 0.55 },
  { maxDays: 14, urgency: 0.3 },
];
export const EXAM_URGENCY_BEYOND = 0.1;

/**
 * Recent-error window (reason code RECENT_ERROR): an incorrect attempt
 * within this many hours marks the concept as recently missed.
 */
export const RECENT_ERROR_WINDOW_HOURS = 72;

/** Emphasis considered "high" for the HIGH_COURSE_EMPHASIS reason code. */
export const HIGH_EMPHASIS_THRESHOLD = 0.7;

/**
 * Session diversity (spec W — bounded, documented):
 *   - at most MAX_CONSECUTIVE_SAME_CONCEPT questions in a row per concept
 *   - no concept exceeds ceil(size × MAX_CONCEPT_SHARE) of a session
 */
export const DIVERSITY = {
  MAX_CONSECUTIVE_SAME_CONCEPT: 2,
  MAX_CONCEPT_SHARE: 0.5,
} as const;

/**
 * Question-supply threshold (spec Y): fewer unseen questions than this for
 * a recommended concept adds the QUESTION_SUPPLY_LOW reason. The engine
 * NEVER calls an AI provider in response — generation stays a background
 * worker concern (M7 ADR-0019).
 */
export const QUESTION_SUPPLY_LOW_THRESHOLD = 3;

/**
 * Mastery-appropriate question characteristics (spec U): difficulty and
 * cognitive progression targets by mastery band. Selection prefers these
 * but falls back gracefully when the bank is thin (spec Y/AN).
 */
export const TARGET_CHARACTERISTICS = {
  /** mastery < NEEDS_REVIEW_BELOW or unassessed */
  low: {
    difficulties: ['easy', 'moderate'] as QuestionDifficulty[],
    cognitiveLevels: ['recall', 'understanding', 'application'] as CognitiveLevel[],
  },
  /** developing band */
  mid: {
    difficulties: ['moderate', 'hard'] as QuestionDifficulty[],
    cognitiveLevels: ['understanding', 'application', 'analysis'] as CognitiveLevel[],
  },
  /** strong band */
  high: {
    difficulties: ['moderate', 'hard'] as QuestionDifficulty[],
    cognitiveLevels: ['application', 'analysis', 'prioritization'] as CognitiveLevel[],
  },
} as const;
