/**
 * Question and assessment domain vocabulary — M7 (spec A/C/E/F/S/T/U;
 * Playbook §11 item schema, §15 question interaction).
 *
 * Pure shared vocabulary only: controlled question types, difficulty,
 * cognitive levels, statuses, confidence scale, session lifecycle, priority
 * frameworks, feedback reasons — and their student-facing labels. Generation,
 * validation, scoring, and persistence live in `@avidia/assessment` and the
 * worker; screens consume these constants and never re-declare them.
 */

/**
 * Question types (spec C). Deliberately limited to interactions that can be
 * scored reliably and deterministically (spec C: "prioritize question types
 * that provide high study value and can be scored reliably"):
 *
 *   - single_best_answer  classic NCLEX-style MCQ, exactly one correct
 *   - multiple_response   Select All That Apply, 2+ correct intentionally
 *   - ordered_response    sequencing (e.g. priority of actions)
 *   - numeric_calculation dosage/rate math with deterministic expected value
 *
 * True/False is intentionally absent (low study value; a two-option
 * single_best_answer covers the rare justified case). Free-text clinical
 * reasoning is deferred until reliable scoring exists (AI-judged free text
 * would violate "scored reliably"). Case-based questions are supported as
 * clinical-vignette STEMS on these types, not as a separate interaction.
 */
export const QUESTION_TYPES = [
  'single_best_answer',
  'multiple_response',
  'ordered_response',
  'numeric_calculation',
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  single_best_answer: 'Multiple choice',
  multiple_response: 'Select all that apply',
  ordered_response: 'Place in order',
  numeric_calculation: 'Calculation',
};

export function isQuestionType(value: string): value is QuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(value);
}

/**
 * Initial difficulty (spec F): coarse, AI-estimated METADATA — not objective
 * truth. M8 may refine difficulty from real student performance; nothing in
 * M7 treats this as more than a mixing/diversity signal.
 */
export const QUESTION_DIFFICULTIES = ['easy', 'moderate', 'hard'] as const;
export type QuestionDifficulty = (typeof QUESTION_DIFFICULTIES)[number];

export const QUESTION_DIFFICULTY_LABELS: Record<QuestionDifficulty, string> = {
  easy: 'Easy',
  moderate: 'Moderate',
  hard: 'Hard',
};

export function isQuestionDifficulty(value: string): value is QuestionDifficulty {
  return (QUESTION_DIFFICULTIES as readonly string[]).includes(value);
}

/**
 * Cognitive level (spec E): extensible classification used to diversify
 * assessments and, later, adaptive selection. Explicitly imperfect — an
 * estimate, never a claim of psychometric rigor.
 */
export const COGNITIVE_LEVELS = [
  'recall',
  'understanding',
  'application',
  'analysis',
  'prioritization',
] as const;

export type CognitiveLevel = (typeof COGNITIVE_LEVELS)[number];

export const COGNITIVE_LEVEL_LABELS: Record<CognitiveLevel, string> = {
  recall: 'Recall',
  understanding: 'Understanding',
  application: 'Application',
  analysis: 'Analysis',
  prioritization: 'Prioritization',
};

export function isCognitiveLevel(value: string): value is CognitiveLevel {
  return (COGNITIVE_LEVELS as readonly string[]).includes(value);
}

/**
 * Course-grounded vs general nursing knowledge (spec H; Playbook §17).
 * course_grounded questions carry chunk provenance and may say "based on
 * your materials"; general_knowledge questions are labeled internally and
 * NEVER attributed to the student's uploads.
 */
export const QUESTION_SOURCE_TYPES = ['course_grounded', 'general_knowledge'] as const;
export type QuestionSourceType = (typeof QUESTION_SOURCE_TYPES)[number];

export const QUESTION_SOURCE_TYPE_LABELS: Record<QuestionSourceType, string> = {
  course_grounded: 'From your course materials',
  general_knowledge: 'General nursing knowledge',
};

/**
 * Question lifecycle (spec S; review gate added 2026-08-25, see
 * docs/architecture-decisions/ADR-0018-question-schema.md §4). The
 * generation pipeline validates BEFORE persistence, so accepted rows land as
 * 'generated' (clean, routine review) or 'flagged' (usable-looking but
 * carrying safety/quality warnings, priority review) — never straight to
 * 'active'. A reviewer's decision through the content-review tool is what
 * moves a question to 'active' (approve) or 'rejected' (reject); 'retired'
 * is a separate automated lifecycle state for evidence loss. Study sessions
 * only ever see 'active'.
 */
export const QUESTION_STATUSES = ['generated', 'active', 'flagged', 'rejected', 'retired'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/**
 * Confidence scale (spec U; Playbook §15 step 7). M7 only CAPTURES this as
 * clean data on the attempt; converting confidence into mastery/calibration
 * belongs to M8.
 */
export const CONFIDENCE_LEVELS = ['guessing', 'unsure', 'pretty_sure', 'certain'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const CONFIDENCE_LEVEL_LABELS: Record<ConfidenceLevel, string> = {
  guessing: 'Guessing',
  unsure: 'Unsure',
  pretty_sure: 'Pretty sure',
  certain: 'Certain',
};

export function isConfidenceLevel(value: string): value is ConfidenceLevel {
  return (CONFIDENCE_LEVELS as readonly string[]).includes(value);
}

/**
 * Study session lifecycle (spec T). 'abandoned' is set when a student starts
 * a new session while one is unfinished — history stays honest without
 * blocking the student.
 */
export const SESSION_STATUSES = ['in_progress', 'completed', 'abandoned'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_TYPES = ['practice'] as const;
export type SessionType = (typeof SESSION_TYPES)[number];

/**
 * Nursing priority frameworks (spec O; Playbook §11 priority_framework).
 * Metadata on questions that involve prioritization — context determines the
 * answer, never one simplistic rule.
 */
export const PRIORITY_FRAMEWORKS = [
  'abc',
  'safety',
  'acute_vs_chronic',
  'unstable_vs_stable',
  'actual_vs_potential',
  'least_restrictive',
] as const;

export type PriorityFramework = (typeof PRIORITY_FRAMEWORKS)[number];

export const PRIORITY_FRAMEWORK_LABELS: Record<PriorityFramework, string> = {
  abc: 'Airway / Breathing / Circulation',
  safety: 'Safety',
  acute_vs_chronic: 'Acute vs chronic',
  unstable_vs_stable: 'Unstable vs stable',
  actual_vs_potential: 'Actual vs potential',
  least_restrictive: 'Least restrictive intervention',
};

export function isPriorityFramework(value: string): value is PriorityFramework {
  return (PRIORITY_FRAMEWORKS as readonly string[]).includes(value);
}

/**
 * Student feedback reasons for flagging a generated question (spec AH).
 * Stored for review; a flag never silently changes the recorded answer.
 */
export const QUESTION_FEEDBACK_REASONS = [
  'answer_wrong',
  'question_unclear',
  'rationale_unclear',
  'source_mismatch',
  'other',
] as const;

export type QuestionFeedbackReason = (typeof QUESTION_FEEDBACK_REASONS)[number];

export const QUESTION_FEEDBACK_REASON_LABELS: Record<QuestionFeedbackReason, string> = {
  answer_wrong: 'The answer seems wrong',
  question_unclear: 'The question is unclear',
  rationale_unclear: 'The explanation is unclear',
  source_mismatch: "The source doesn't support this",
  other: 'Something else',
};

/**
 * M7 question-generation lifecycle — a FOURTH independent document lifecycle
 * alongside processing_status (M4, read), index_status (M5, retrieve) and
 * knowledge_status (M6, know). question_status answers "have practice
 * questions been generated from this document's concepts?".
 *
 *   pending -> generating -> ready | failed;  failed/generating -> pending (retry)
 *
 * Re-extraction (knowledge changes) resets it to 'pending'. A generation
 * failure never affects reading, retrieval, or concepts, and previously
 * validated questions remain usable (spec AE).
 */
export const QUESTION_GENERATION_STATUSES = ['pending', 'generating', 'ready', 'failed'] as const;
export type QuestionGenerationStatus = (typeof QUESTION_GENERATION_STATUSES)[number];
