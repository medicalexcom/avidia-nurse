/**
 * Cognitive-level and difficulty analytics — M12 (spec J/K).
 *
 * Simple grouped accuracy over stored question metadata. A row only shows
 * accuracy once it clears MIN_CATEGORY_ATTEMPTS; otherwise it reports its
 * count with the honest "not enough data yet" (spec AJ). Deterministic
 * grouping over stored enums — nothing inferred.
 */

import type { CognitiveLevel, QuestionDifficulty } from '@avidia/domain';
import { COGNITIVE_LEVELS, QUESTION_DIFFICULTIES } from '@avidia/domain';
import { MIN_CATEGORY_ATTEMPTS } from './thresholds';
import type { AccuracySlice, AttemptRecord } from './types';
import { accuracySlice } from './types';

export interface CategoryRow<K extends string> {
  key: K;
  attempts: number;
  /** Present only once MIN_CATEGORY_ATTEMPTS is met (spec J/K). */
  accuracy: AccuracySlice | null;
}

function rowsFor<K extends string>(
  keys: readonly K[],
  attempts: readonly AttemptRecord[],
  keyOf: (attempt: AttemptRecord) => K
): CategoryRow<K>[] {
  return keys.map((key) => {
    const matching = attempts.filter((a) => keyOf(a) === key);
    const slice = accuracySlice(matching.filter((a) => a.isCorrect).length, matching.length);
    return {
      key,
      attempts: matching.length,
      accuracy: matching.length >= MIN_CATEGORY_ATTEMPTS ? slice : null,
    };
  });
}

export function cognitiveLevelRows(
  attempts: readonly AttemptRecord[]
): CategoryRow<CognitiveLevel>[] {
  return rowsFor(COGNITIVE_LEVELS, attempts, (a) => a.cognitiveLevel);
}

export function difficultyRows(
  attempts: readonly AttemptRecord[]
): CategoryRow<QuestionDifficulty>[] {
  return rowsFor(QUESTION_DIFFICULTIES, attempts, (a) => a.difficulty);
}
