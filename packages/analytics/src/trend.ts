/**
 * Deterministic trend classification — M12 (spec G).
 *
 * A trend compares accuracy in the recent window against the previous
 * window of equal length. The rules are fixed, documented, and threshold-
 * gated: no LLM interpretation, no reaction to a single question. When
 * either window lacks MIN_TREND_ATTEMPTS_PER_WINDOW attempts the answer is
 * honestly 'insufficient' — never a guess.
 */

import { MIN_TREND_ATTEMPTS_PER_WINDOW, TREND_DELTA_THRESHOLD } from './thresholds';
import type { Trend } from './types';

export interface TrendResult {
  trend: Trend;
  /** Accuracy in each window, or null when the window is empty. */
  recentAccuracy: number | null;
  previousAccuracy: number | null;
  recentCount: number;
  previousCount: number;
}

interface Outcome {
  isCorrect: boolean;
}

function accuracy(outcomes: readonly Outcome[]): number | null {
  if (outcomes.length === 0) return null;
  return outcomes.filter((o) => o.isCorrect).length / outcomes.length;
}

/**
 * Classify a trend from two pre-split windows:
 *   - either window below the minimum → 'insufficient'
 *   - delta ≥ +TREND_DELTA_THRESHOLD → 'improving'
 *   - delta ≤ −TREND_DELTA_THRESHOLD → 'declining'
 *   - otherwise → 'stable'
 */
export function classifyTrend(
  recent: readonly Outcome[],
  previous: readonly Outcome[]
): TrendResult {
  const recentAccuracy = accuracy(recent);
  const previousAccuracy = accuracy(previous);
  const base: Omit<TrendResult, 'trend'> = {
    recentAccuracy,
    previousAccuracy,
    recentCount: recent.length,
    previousCount: previous.length,
  };
  if (
    recent.length < MIN_TREND_ATTEMPTS_PER_WINDOW ||
    previous.length < MIN_TREND_ATTEMPTS_PER_WINDOW ||
    recentAccuracy === null ||
    previousAccuracy === null
  ) {
    return { trend: 'insufficient', ...base };
  }
  const delta = recentAccuracy - previousAccuracy;
  if (delta >= TREND_DELTA_THRESHOLD) return { trend: 'improving', ...base };
  if (delta <= -TREND_DELTA_THRESHOLD) return { trend: 'declining', ...base };
  return { trend: 'stable', ...base };
}
