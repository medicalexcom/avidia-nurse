import { QuestionGenerationMetadata } from './gateway';
import { GenerationChunk } from './schema';
import { ValidatedQuestion } from './validate';

/**
 * Mapping from validated questions to the apply_question_generation RPC
 * payload (M7 spec G/J/Q). The worker validates BEFORE persistence, so only
 * ValidatedQuestion values (status 'generated' or 'flagged') ever reach
 * here — the database never sees malformed generation output (spec J), and
 * neither status is student-visible until a reviewer approves the question
 * (docs/architecture-decisions/ADR-0018-question-schema.md §4).
 */

export interface QuestionRpcOption {
  ordinal: number;
  text: string;
  is_correct: boolean;
  correct_position: number | null;
  rationale: string | null;
}

export interface QuestionRpcEntry {
  content_hash: string;
  concept_key: string;
  question_type: string;
  stem: string;
  difficulty: string;
  cognitive_level: string;
  source_type: string;
  priority_frameworks: string[];
  rationale: string;
  expected_value: number | null;
  tolerance: number | null;
  answer_unit: string | null;
  rounding_note: string | null;
  status: 'generated' | 'flagged';
  safety_flags: string[];
  options: QuestionRpcOption[];
  /** Chunk UUIDs resolved from the model's 0-based chunk_indexes (spec Q). */
  chunk_ids: string[];
}

export interface QuestionGenerationRpcPayload {
  generation: {
    provider: string;
    model: string;
    prompt_version: string;
    generation_version: string;
  };
  questions: QuestionRpcEntry[];
}

/**
 * Build the RPC payload. Chunk indexes outside the batch are silently dropped
 * (the structural validator already rejects them; this is defense in depth) —
 * a question that loses all its citations this way is persisted as
 * general_knowledge-labeled evidence-free, which the RPC's retire pass and
 * spec H labeling rules then treat honestly.
 */
export function toQuestionRpcPayload(
  accepted: readonly ValidatedQuestion[],
  chunks: readonly GenerationChunk[],
  metadata: QuestionGenerationMetadata
): QuestionGenerationRpcPayload {
  return {
    generation: {
      provider: metadata.provider,
      model: metadata.model,
      prompt_version: metadata.promptVersion,
      generation_version: metadata.generationVersion,
    },
    questions: accepted.map((question) => ({
      content_hash: question.contentHash,
      concept_key: question.conceptKey,
      question_type: question.questionType,
      stem: question.stem,
      difficulty: question.difficulty,
      cognitive_level: question.cognitiveLevel,
      source_type: question.sourceType,
      priority_frameworks: question.priorityFrameworks,
      rationale: question.rationale,
      expected_value: question.expectedValue,
      tolerance: question.tolerance,
      answer_unit: question.answerUnit,
      rounding_note: question.roundingNote,
      status: question.status,
      safety_flags: question.safetyFlags,
      options: question.options.map((option) => ({
        ordinal: option.ordinal,
        text: option.text,
        is_correct: option.isCorrect,
        correct_position: option.correctPosition,
        rationale: option.rationale,
      })),
      chunk_ids: question.chunkIndexes
        .filter((index) => index >= 0 && index < chunks.length)
        .map((index) => chunks[index]!.id),
    })),
  };
}
