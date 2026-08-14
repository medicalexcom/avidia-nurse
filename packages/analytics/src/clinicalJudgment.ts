/**
 * Clinical-judgment analytics — M12 (spec Y).
 *
 * Presents the two independent evidence sources SIDE BY SIDE — question
 * performance at the higher cognitive levels (analysis/prioritization,
 * M7/M10) and simulation dimension performance (M11) — WITHOUT combining
 * them into a single invented score. The same underlying attempt is never
 * counted twice because the two panels read disjoint datasets: question
 * attempts on one side, simulation dimension points on the other.
 */

import { MIN_CATEGORY_ATTEMPTS } from './thresholds';
import { computeSimulationAnalytics, type SimulationDimensionSummary } from './simulationAnalytics';
import type { AccuracySlice, AttemptRecord, SimulationRecord } from './types';
import { accuracySlice } from './types';

export interface ClinicalJudgmentAnalytics {
  /** Question-side: accuracy on analysis-level questions. */
  analysisQuestions: { attempts: number; accuracy: AccuracySlice | null };
  /** Question-side: accuracy on prioritization-level questions. */
  prioritizationQuestions: { attempts: number; accuracy: AccuracySlice | null };
  /** Simulation-side: aggregated CJMM dimension performance. */
  simulationDimensions: SimulationDimensionSummary[];
  completedSimulations: number;
}

function levelSlice(
  attempts: readonly AttemptRecord[],
  level: 'analysis' | 'prioritization'
): { attempts: number; accuracy: AccuracySlice | null } {
  const matching = attempts.filter((a) => a.cognitiveLevel === level);
  const slice = accuracySlice(matching.filter((a) => a.isCorrect).length, matching.length);
  return {
    attempts: matching.length,
    accuracy: matching.length >= MIN_CATEGORY_ATTEMPTS ? slice : null,
  };
}

export function computeClinicalJudgment(
  attempts: readonly AttemptRecord[],
  simulations: readonly SimulationRecord[]
): ClinicalJudgmentAnalytics {
  const sim = computeSimulationAnalytics(simulations);
  return {
    analysisQuestions: levelSlice(attempts, 'analysis'),
    prioritizationQuestions: levelSlice(attempts, 'prioritization'),
    simulationDimensions: sim.dimensions,
    completedSimulations: sim.completedCount,
  };
}
