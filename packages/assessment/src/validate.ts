import {
  CognitiveLevel,
  isPriorityFramework,
  PriorityFramework,
  QuestionDifficulty,
  QuestionSourceType,
  QuestionType,
} from '@avidia/domain';

import { computeQuestionContentHash, normalizeQuestionText } from './hash';
import { RawGeneratedQuestion } from './schema';

/**
 * Clinical validation pipeline (M7 spec K/L/N, ADR-0021; review gate added
 * 2026-08-25, see docs/architecture-decisions/ADR-0018-question-schema.md §4).
 *
 * Every structurally valid question from the generator is judged here BEFORE
 * persistence. Hard rule violations (wrong option counts, answer leakage,
 * missing deterministic math) REJECT the question — it never lands in the
 * database as usable. Everything else that passes lands EXCLUDED from study
 * sessions until a human reviewer approves it via the content-review tool
 * (RLS only ever exposes status='active' to students): clean questions land
 * 'generated' (routine review), and questions with quality/safety concerns
 * land 'flagged' with their safety flags attached (priority review). Neither
 * status is student-visible. Generation is treated as an untrusted content
 * source at every step (spec L).
 */

export interface ValidatedOption {
  /** Deterministic 1-based presentation order (spec B). */
  ordinal: number;
  text: string;
  isCorrect: boolean;
  correctPosition: number | null;
  rationale: string | null;
}

export interface ValidatedQuestion {
  questionType: QuestionType;
  stem: string;
  difficulty: QuestionDifficulty;
  cognitiveLevel: CognitiveLevel;
  conceptKey: string;
  priorityFrameworks: PriorityFramework[];
  /** Derived from citations, never claimed by the model (spec H). */
  sourceType: QuestionSourceType;
  rationale: string;
  options: ValidatedOption[];
  expectedValue: number | null;
  tolerance: number | null;
  answerUnit: string | null;
  roundingNote: string | null;
  chunkIndexes: number[];
  contentHash: string;
  /**
   * 'generated' when clean (routine human review before going live);
   * 'flagged' when carrying safety/quality warnings (priority review).
   * Never 'active' here — only a reviewer's approval sets that.
   */
  status: 'generated' | 'flagged';
  safetyFlags: string[];
}

export type QuestionValidationResult =
  { ok: true; value: ValidatedQuestion } | { ok: false; reasons: string[] };

/**
 * High-alert clinical territory (spec L): questions touching these get the
 * stricter checks below. Modeled on ISMP high-alert medication classes plus
 * emergency response — deliberately matched broadly (substring on normalized
 * text) because a missed match is worse than an extra check.
 */
const HIGH_RISK_TERMS = [
  'insulin',
  'heparin',
  'warfarin',
  'anticoagul',
  'enoxaparin',
  'digoxin',
  'potassium chloride',
  'opioid',
  'morphine',
  'fentanyl',
  'hydromorphone',
  'chemotherap',
  'iv push',
  'mg kg',
  'code blue',
  'cardiac arrest',
  'epinephrine',
];

/** Absolute qualifiers that give answers away or are clinically sloppy (spec N). */
const ABSOLUTE_TERMS = [/\balways\b/i, /\bnever\b/i, /^all of the above$/i, /^none of the above$/i];

function isHighRisk(question: RawGeneratedQuestion): boolean {
  const haystack = normalizeQuestionText(
    [question.stem, question.rationale, ...question.options.map((option) => option.text)].join(' ')
  );
  return HIGH_RISK_TERMS.some((term) => haystack.includes(term));
}

/** Validate ONE structurally sound question; classify as active/flagged/rejected. */
export function validateGeneratedQuestion(raw: RawGeneratedQuestion): QuestionValidationResult {
  const reasons: string[] = [];
  const flags: string[] = [];
  const questionType = raw.question_type as QuestionType;
  const optionCount = raw.options.length;
  const correctOptions = raw.options.filter((option) => option.is_correct);
  const normalizedStem = normalizeQuestionText(raw.stem);

  // --- Hard interaction rules (spec K): violations are rejections. ---
  if (questionType === 'single_best_answer') {
    if (optionCount < 3 || optionCount > 6) {
      reasons.push(`single_best_answer needs 3-6 options, got ${optionCount}`);
    }
    if (correctOptions.length !== 1) {
      reasons.push(
        `single_best_answer needs exactly 1 correct option, got ${correctOptions.length}`
      );
    }
  } else if (questionType === 'multiple_response') {
    if (optionCount < 4 || optionCount > 6) {
      reasons.push(`multiple_response needs 4-6 options, got ${optionCount}`);
    }
    if (correctOptions.length < 2) {
      reasons.push(
        `multiple_response needs 2 or more correct options (intentionally), got ${correctOptions.length}`
      );
    }
    if (optionCount > 0 && correctOptions.length === optionCount) {
      reasons.push('multiple_response must not have every option correct');
    }
  } else if (questionType === 'ordered_response') {
    if (optionCount < 3 || optionCount > 6) {
      reasons.push(`ordered_response needs 3-6 options, got ${optionCount}`);
    }
    const positions = raw.options
      .map((option) => option.correct_position)
      .filter((position): position is number => position !== null);
    const expected = Array.from({ length: optionCount }, (_, index) => index + 1);
    const sorted = [...positions].sort((a, b) => a - b);
    if (
      positions.length !== optionCount ||
      !expected.every((value, index) => sorted[index] === value)
    ) {
      reasons.push('ordered_response options must carry correct_position covering 1..n exactly');
    }
  } else if (questionType === 'numeric_calculation') {
    if (optionCount !== 0) {
      reasons.push('numeric_calculation must not have options');
    }
    if (raw.expected_value === null || !Number.isFinite(raw.expected_value)) {
      reasons.push('numeric_calculation requires a finite expected_value');
    }
    if (raw.tolerance === null || !Number.isFinite(raw.tolerance) || raw.tolerance < 0) {
      reasons.push('numeric_calculation requires a tolerance >= 0');
    }
  }
  if (questionType !== 'numeric_calculation') {
    if (raw.expected_value !== null || raw.tolerance !== null) {
      reasons.push('only numeric_calculation may carry expected_value/tolerance');
    }
    if (questionType !== 'ordered_response') {
      if (raw.options.some((option) => option.correct_position !== null)) {
        reasons.push('correct_position is only meaningful on ordered_response');
      }
    }
  }

  // Duplicate options make the interaction ambiguous (spec K).
  const normalizedOptionTexts = raw.options.map((option) => normalizeQuestionText(option.text));
  if (new Set(normalizedOptionTexts).size !== normalizedOptionTexts.length) {
    reasons.push('options must be distinct');
  }

  // Answer leakage (spec K): the stem must not contain a correct option
  // verbatim — the question would answer itself.
  for (const option of correctOptions) {
    const normalized = normalizeQuestionText(option.text);
    if (normalized.length >= 4 && normalizedStem.includes(normalized)) {
      reasons.push('stem contains the correct answer text (answer leakage)');
      break;
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  // --- Quality/safety checks (spec L/M/N): concerns FLAG, never silently pass. ---
  const incorrectMissingRationale = raw.options.some(
    (option) => !option.is_correct && option.rationale.trim().length === 0
  );
  if (incorrectMissingRationale) {
    flags.push('missing_distractor_rationale');
  }
  if (raw.options.some((option) => ABSOLUTE_TERMS.some((term) => term.test(option.text)))) {
    flags.push('absolute_term_option');
  }
  if (questionType === 'single_best_answer') {
    const correctLength = correctOptions[0]!.text.length;
    const distractors = raw.options.filter((option) => !option.is_correct);
    if (distractors.every((option) => correctLength >= option.text.length * 1.6)) {
      flags.push('longest_option_correct');
    }
  }
  if (isHighRisk(raw)) {
    // Stronger validation in high-alert territory (spec L).
    if (questionType === 'numeric_calculation') {
      if (raw.answer_unit === null || raw.answer_unit.trim().length === 0) {
        flags.push('high_risk_missing_unit');
      }
      const expected = Math.abs(raw.expected_value ?? 0);
      const limit = expected > 0 ? expected * 0.1 : 0.5;
      if ((raw.tolerance ?? 0) > limit) {
        flags.push('high_risk_wide_tolerance');
      }
    } else if (raw.rationale.trim().length < 60) {
      flags.push('high_risk_thin_rationale');
    }
  }

  const chunkIndexes = [...new Set(raw.chunk_indexes)].sort((a, b) => a - b);
  return {
    ok: true,
    value: {
      questionType,
      stem: raw.stem.trim(),
      difficulty: raw.difficulty as QuestionDifficulty,
      cognitiveLevel: raw.cognitive_level as CognitiveLevel,
      conceptKey: raw.concept_key.trim(),
      priorityFrameworks: [...new Set(raw.priority_frameworks.filter(isPriorityFramework))],
      // Derived, never trusted (spec H / Playbook §17): no citations means the
      // question may not claim the student's materials.
      sourceType: chunkIndexes.length > 0 ? 'course_grounded' : 'general_knowledge',
      rationale: raw.rationale.trim(),
      options: raw.options.map((option, index) => ({
        ordinal: index + 1,
        text: option.text.trim(),
        isCorrect: option.is_correct,
        correctPosition: option.correct_position,
        rationale: option.rationale.trim().length > 0 ? option.rationale.trim() : null,
      })),
      expectedValue: raw.expected_value,
      tolerance: raw.tolerance,
      answerUnit: raw.answer_unit?.trim() || null,
      roundingNote: raw.rounding_note?.trim() || null,
      chunkIndexes,
      contentHash: computeQuestionContentHash(
        questionType,
        raw.stem,
        raw.options.map((option) => option.text)
      ),
      status: flags.length > 0 ? 'flagged' : 'generated',
      safetyFlags: flags,
    },
  };
}

export interface GenerationBatchResult {
  accepted: ValidatedQuestion[];
  rejected: { question: RawGeneratedQuestion; reasons: string[] }[];
  duplicatesRemoved: number;
}

/**
 * Validate a whole batch: rejections are collected (with reasons, for logs),
 * and in-batch duplicates by content hash are dropped (spec R) — the database
 * unique constraint then handles cross-run duplicates.
 */
export function validateGenerationBatch(
  raws: readonly RawGeneratedQuestion[]
): GenerationBatchResult {
  const accepted: ValidatedQuestion[] = [];
  const rejected: { question: RawGeneratedQuestion; reasons: string[] }[] = [];
  const seenHashes = new Set<string>();
  let duplicatesRemoved = 0;
  for (const raw of raws) {
    const result = validateGeneratedQuestion(raw);
    if (!result.ok) {
      rejected.push({ question: raw, reasons: result.reasons });
      continue;
    }
    if (seenHashes.has(result.value.contentHash)) {
      duplicatesRemoved += 1;
      continue;
    }
    seenHashes.add(result.value.contentHash);
    accepted.push(result.value);
  }
  return { accepted, rejected, duplicatesRemoved };
}
