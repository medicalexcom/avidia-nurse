/**
 * Deterministic error patterns — M12 (spec AB).
 *
 * Fixed, documented rules over incorrect attempts. Each pattern requires
 * MIN_PATTERN_ERRORS matching misses AND a majority signal where relevant,
 * so one bad day never becomes a "pattern". No clustering, no inference,
 * no LLM — a pattern either matches its rule or it does not.
 */

import { MIN_PATTERN_ERRORS } from './thresholds';
import type { AttemptRecord } from './types';

export type ErrorPatternCode =
  | 'high_confidence_misses'
  | 'prioritization_misses'
  | 'hard_difficulty_misses'
  | 'repeat_concept_misses';

export const ERROR_PATTERN_LABELS: Record<ErrorPatternCode, string> = {
  high_confidence_misses: 'Several misses came while feeling sure of the answer',
  prioritization_misses: 'Misses cluster on "who/what first" prioritization questions',
  hard_difficulty_misses: 'Misses cluster on the hardest questions',
  repeat_concept_misses: 'The same concept was missed repeatedly',
};

export interface ErrorPattern {
  code: ErrorPatternCode;
  label: string;
  /** How many incorrect attempts back this pattern. */
  evidenceCount: number;
  /** The concept behind repeat_concept_misses, when applicable. */
  conceptId: string | null;
}

export function computeErrorPatterns(attempts: readonly AttemptRecord[]): ErrorPattern[] {
  const incorrect = attempts.filter((a) => !a.isCorrect);
  const patterns: ErrorPattern[] = [];
  if (incorrect.length === 0) return patterns;

  const highConfidence = incorrect.filter(
    (a) => a.confidence === 'certain' || a.confidence === 'pretty_sure'
  );
  if (highConfidence.length >= MIN_PATTERN_ERRORS) {
    patterns.push({
      code: 'high_confidence_misses',
      label: ERROR_PATTERN_LABELS.high_confidence_misses,
      evidenceCount: highConfidence.length,
      conceptId: null,
    });
  }

  const prioritization = incorrect.filter((a) => a.cognitiveLevel === 'prioritization');
  if (
    prioritization.length >= MIN_PATTERN_ERRORS &&
    prioritization.length * 2 >= incorrect.length
  ) {
    patterns.push({
      code: 'prioritization_misses',
      label: ERROR_PATTERN_LABELS.prioritization_misses,
      evidenceCount: prioritization.length,
      conceptId: null,
    });
  }

  const hard = incorrect.filter((a) => a.difficulty === 'hard');
  if (hard.length >= MIN_PATTERN_ERRORS && hard.length * 2 >= incorrect.length) {
    patterns.push({
      code: 'hard_difficulty_misses',
      label: ERROR_PATTERN_LABELS.hard_difficulty_misses,
      evidenceCount: hard.length,
      conceptId: null,
    });
  }

  const missesByConcept = new Map<string, number>();
  for (const attempt of incorrect) {
    if (attempt.conceptId === null) continue;
    missesByConcept.set(attempt.conceptId, (missesByConcept.get(attempt.conceptId) ?? 0) + 1);
  }
  const repeated = [...missesByConcept.entries()]
    .filter(([, count]) => count >= MIN_PATTERN_ERRORS)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const topRepeated = repeated[0];
  if (topRepeated !== undefined) {
    patterns.push({
      code: 'repeat_concept_misses',
      label: ERROR_PATTERN_LABELS.repeat_concept_misses,
      evidenceCount: topRepeated[1],
      conceptId: topRepeated[0],
    });
  }

  return patterns;
}
