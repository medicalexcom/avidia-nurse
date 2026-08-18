import { isCognitiveLevel, isQuestionDifficulty, isQuestionType } from '@avidia/domain';

/**
 * Strict structured-output contract for AI question generation (M7 spec J,
 * ADR-0021). AI output is UNTRUSTED input: everything is validated field by
 * field before it may influence the database. Anything that fails schema
 * validation is rejected (the gateway then attempts one controlled repair
 * round); arbitrary JSON never reaches persistence.
 *
 * Schema validation here is purely STRUCTURAL. The clinical validation
 * pipeline (validate.ts) then judges each structurally sound question on
 * correctness rules, safety, and distractor quality (spec K/L/N).
 */

/** One chunk given to the generator, with its stable id and provenance hint. */
export interface GenerationChunk {
  /** source_chunks.id — ties every generated question back to evidence. */
  id: string;
  content: string;
  /** Human-readable provenance ("slide 17 — Pulmonary Embolism") for the prompt. */
  locator: string;
}

/** One concept the generator is asked to write questions about. */
export interface GenerationConcept {
  /** concepts.normalized_key — resolved back to concept_id at persistence. */
  key: string;
  name: string;
  type: string;
  /** Transparent M6 emphasis (spec AA): generation metadata, never a promise. */
  emphasisScore: number;
}

/** Raw (already schema-validated) option candidate from the model. */
export interface RawGeneratedOption {
  text: string;
  is_correct: boolean;
  /** 1-based position in the correct sequence; ordered_response only. */
  correct_position: number | null;
  /** Why this option is right/wrong (spec M). */
  rationale: string;
}

/** Raw (already schema-validated) question candidate from the model. */
export interface RawGeneratedQuestion {
  question_type: string;
  stem: string;
  difficulty: string;
  cognitive_level: string;
  /** Normalized key of the primary concept (from the supplied concept list). */
  concept_key: string;
  priority_frameworks: string[];
  rationale: string;
  options: RawGeneratedOption[];
  /** Deterministic math fields (spec P); numeric_calculation only. */
  expected_value: number | null;
  tolerance: number | null;
  answer_unit: string | null;
  rounding_note: string | null;
  /** 0-based indexes into the submitted chunk batch that support the question. */
  chunk_indexes: number[];
}

export interface RawGeneration {
  questions: RawGeneratedQuestion[];
}

export type GenerationSchemaResult =
  { ok: true; value: RawGeneration } | { ok: false; errors: string[] };

export const MAX_QUESTIONS_PER_BATCH = 30;
export const MAX_OPTIONS_PER_QUESTION = 6;
export const MIN_STEM_LENGTH = 20;
export const MAX_STEM_LENGTH = 3000;
export const MIN_RATIONALE_LENGTH = 20;
export const MAX_RATIONALE_LENGTH = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIndexArray(value: unknown, chunkCount: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item < chunkCount
    )
  );
}

/**
 * Validate a parsed model response against the generation schema. `chunkCount`
 * bounds every chunk index — the model can only cite chunks it was shown.
 * Structural violations are errors (reject/repair); clinical judgments
 * (correct-answer counts, safety, distractor quality) belong to the
 * validation pipeline so one weak question cannot discard a good batch.
 */
export function validateGeneration(raw: unknown, chunkCount: number): GenerationSchemaResult {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: ['response is not a JSON object'] };
  }
  const questions = raw.questions;
  if (!Array.isArray(questions)) {
    return { ok: false, errors: ['questions must be an array'] };
  }
  if (questions.length > MAX_QUESTIONS_PER_BATCH) {
    errors.push(`too many questions (${questions.length} > ${MAX_QUESTIONS_PER_BATCH})`);
  }
  questions.forEach((question, index) => {
    if (!isRecord(question)) {
      errors.push(`questions[${index}] is not an object`);
      return;
    }
    if (typeof question.question_type !== 'string' || !isQuestionType(question.question_type)) {
      errors.push(`questions[${index}].question_type must be a supported question type`);
    }
    if (
      typeof question.stem !== 'string' ||
      question.stem.trim().length < MIN_STEM_LENGTH ||
      question.stem.length > MAX_STEM_LENGTH
    ) {
      errors.push(
        `questions[${index}].stem must be a string of ${MIN_STEM_LENGTH}-${MAX_STEM_LENGTH} characters`
      );
    }
    if (typeof question.difficulty !== 'string' || !isQuestionDifficulty(question.difficulty)) {
      errors.push(`questions[${index}].difficulty must be easy, moderate or hard`);
    }
    if (
      typeof question.cognitive_level !== 'string' ||
      !isCognitiveLevel(question.cognitive_level)
    ) {
      errors.push(`questions[${index}].cognitive_level must be a supported cognitive level`);
    }
    if (typeof question.concept_key !== 'string' || question.concept_key.trim().length === 0) {
      errors.push(`questions[${index}].concept_key must be a non-empty string`);
    }
    if (
      !Array.isArray(question.priority_frameworks) ||
      !question.priority_frameworks.every((item) => typeof item === 'string')
    ) {
      errors.push(`questions[${index}].priority_frameworks must be an array of strings`);
    }
    if (
      typeof question.rationale !== 'string' ||
      question.rationale.trim().length < MIN_RATIONALE_LENGTH ||
      question.rationale.length > MAX_RATIONALE_LENGTH
    ) {
      errors.push(
        `questions[${index}].rationale must be a string of ${MIN_RATIONALE_LENGTH}-${MAX_RATIONALE_LENGTH} characters`
      );
    }
    if (!Array.isArray(question.options)) {
      errors.push(`questions[${index}].options must be an array`);
    } else {
      if (question.options.length > MAX_OPTIONS_PER_QUESTION) {
        errors.push(`questions[${index}] has more than ${MAX_OPTIONS_PER_QUESTION} options`);
      }
      question.options.forEach((option, optionIndex) => {
        if (!isRecord(option)) {
          errors.push(`questions[${index}].options[${optionIndex}] is not an object`);
          return;
        }
        if (typeof option.text !== 'string' || option.text.trim().length === 0) {
          errors.push(`questions[${index}].options[${optionIndex}].text must be non-empty`);
        }
        if (typeof option.is_correct !== 'boolean') {
          errors.push(`questions[${index}].options[${optionIndex}].is_correct must be boolean`);
        }
        if (
          option.correct_position !== null &&
          (typeof option.correct_position !== 'number' ||
            !Number.isInteger(option.correct_position) ||
            option.correct_position < 1)
        ) {
          errors.push(
            `questions[${index}].options[${optionIndex}].correct_position must be null or a positive integer`
          );
        }
        if (typeof option.rationale !== 'string') {
          errors.push(`questions[${index}].options[${optionIndex}].rationale must be a string`);
        }
      });
    }
    for (const field of ['expected_value', 'tolerance'] as const) {
      const value = question[field];
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        errors.push(`questions[${index}].${field} must be null or a finite number`);
      }
    }
    for (const field of ['answer_unit', 'rounding_note'] as const) {
      const value = question[field];
      if (value !== null && typeof value !== 'string') {
        errors.push(`questions[${index}].${field} must be null or a string`);
      }
    }
    if (!isIndexArray(question.chunk_indexes, chunkCount)) {
      errors.push(`questions[${index}].chunk_indexes must be integers in [0, ${chunkCount - 1}]`);
    }
  });
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: { questions: questions as unknown as RawGeneratedQuestion[] } };
}

/**
 * JSON Schema handed to providers that support constrained decoding (OpenAI
 * structured outputs). Kept in lockstep with validateGeneration — constrained
 * decoding reduces repair rounds, but validateGeneration remains the
 * authority (spec J: never trust arbitrary model JSON).
 */
export function generationJsonSchema(
  questionTypes: readonly string[],
  difficulties: readonly string[],
  cognitiveLevels: readonly string[],
  priorityFrameworks: readonly string[]
) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'question_type',
            'stem',
            'difficulty',
            'cognitive_level',
            'concept_key',
            'priority_frameworks',
            'rationale',
            'options',
            'expected_value',
            'tolerance',
            'answer_unit',
            'rounding_note',
            'chunk_indexes',
          ],
          properties: {
            question_type: { type: 'string', enum: [...questionTypes] },
            stem: { type: 'string' },
            difficulty: { type: 'string', enum: [...difficulties] },
            cognitive_level: { type: 'string', enum: [...cognitiveLevels] },
            concept_key: { type: 'string' },
            priority_frameworks: {
              type: 'array',
              items: { type: 'string', enum: [...priorityFrameworks] },
            },
            rationale: { type: 'string' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['text', 'is_correct', 'correct_position', 'rationale'],
                properties: {
                  text: { type: 'string' },
                  is_correct: { type: 'boolean' },
                  correct_position: { type: ['integer', 'null'] },
                  rationale: { type: 'string' },
                },
              },
            },
            expected_value: { type: ['number', 'null'] },
            tolerance: { type: ['number', 'null'] },
            answer_unit: { type: ['string', 'null'] },
            rounding_note: { type: ['string', 'null'] },
            chunk_indexes: { type: 'array', items: { type: 'integer' } },
          },
        },
      },
    },
  } as const;
}
