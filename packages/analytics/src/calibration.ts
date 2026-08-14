/**
 * Confidence calibration — M12 (spec L).
 *
 * Crosses self-reported confidence with correctness:
 *   correct   + high confidence  → calibrated knowledge
 *   incorrect + high confidence  → potential misconception signal
 *   correct   + low confidence   → underconfident ("you know more than you think")
 *   incorrect + low confidence   → recognized gap (healthy self-awareness)
 *
 * "High" = pretty_sure/certain, "low" = guessing/unsure. Attempts with no
 * confidence report are excluded, and their count is reported honestly.
 * Language stays supportive, never punitive (spec L).
 */

import type { ConfidenceLevel } from '@avidia/domain';
import { MIN_CALIBRATION_ATTEMPTS, MIN_HIGH_CONFIDENCE_ERRORS } from './thresholds';
import type { AttemptRecord } from './types';

export type CalibrationCell =
  'calibrated_confident' | 'overconfident' | 'underconfident' | 'aware_gap';

export const CALIBRATION_CELL_LABELS: Record<CalibrationCell, string> = {
  calibrated_confident: 'Confident and correct',
  overconfident: 'Missed while feeling sure',
  underconfident: 'Correct while unsure',
  aware_gap: 'Unsure and missed',
};

export interface CalibrationResult {
  /** Attempt counts per cell (only confidence-tagged attempts). */
  cells: Record<CalibrationCell, number>;
  taggedCount: number;
  untaggedCount: number;
  /** Whether enough tagged evidence exists to say anything (spec AJ). */
  sufficient: boolean;
  /**
   * True when repeated high-confidence misses exist — a potential
   * misconception SIGNAL to check, never a diagnosis (spec L/M).
   */
  overconfidenceSignal: boolean;
  /** Share of tagged attempts that are calibrated_confident, or null. */
  calibratedShare: number | null;
}

const HIGH: readonly ConfidenceLevel[] = ['pretty_sure', 'certain'];

export function cellFor(isCorrect: boolean, confidence: ConfidenceLevel): CalibrationCell {
  const high = HIGH.includes(confidence);
  if (isCorrect) return high ? 'calibrated_confident' : 'underconfident';
  return high ? 'overconfident' : 'aware_gap';
}

export function computeCalibration(attempts: readonly AttemptRecord[]): CalibrationResult {
  const cells: Record<CalibrationCell, number> = {
    calibrated_confident: 0,
    overconfident: 0,
    underconfident: 0,
    aware_gap: 0,
  };
  let taggedCount = 0;
  let untaggedCount = 0;
  for (const attempt of attempts) {
    if (attempt.confidence === null) {
      untaggedCount += 1;
      continue;
    }
    taggedCount += 1;
    cells[cellFor(attempt.isCorrect, attempt.confidence)] += 1;
  }
  const sufficient = taggedCount >= MIN_CALIBRATION_ATTEMPTS;
  return {
    cells,
    taggedCount,
    untaggedCount,
    sufficient,
    overconfidenceSignal: sufficient && cells.overconfident >= MIN_HIGH_CONFIDENCE_ERRORS,
    calibratedShare: sufficient ? cells.calibrated_confident / taggedCount : null,
  };
}
