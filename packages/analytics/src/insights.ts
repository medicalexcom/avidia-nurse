/**
 * Actionable insights — M12 (spec AC/AD).
 *
 * A fixed, ordered rule list that turns already-computed analytics into at
 * most MAX_INSIGHTS next actions, each pointing INTO an existing engine
 * (M9 adaptive session, concept practice, an M10 mode, M11 simulation) —
 * analytics that ends in a dead end is a spec AC failure, and analytics
 * never invents a new study pathway of its own (spec S).
 */

import type { ConceptAnalyticsResult } from './conceptAnalytics';
import type { CalibrationResult } from './calibration';
import type { ErrorPattern } from './errorPatterns';
import type { SimulationAnalytics } from './simulationAnalytics';
import type { StudyConsistency } from './consistency';
import { MAX_INSIGHTS } from './thresholds';
import type { Insight } from './types';

export interface InsightInputs {
  conceptAnalytics: ConceptAnalyticsResult;
  calibration: CalibrationResult;
  errorPatterns: ErrorPattern[];
  simulation: SimulationAnalytics;
  consistency: StudyConsistency;
  dueForReviewCount: number;
}

export function computeInsights(inputs: InsightInputs): Insight[] {
  const insights: Insight[] = [];
  const top = inputs.conceptAnalytics.needsAttention[0];

  if (top !== undefined) {
    insights.push({
      code: 'attention_concept',
      message: `${top.canonicalName} could use another look — a short focused session is the fastest fix.`,
      action: {
        kind: 'practice_concept',
        conceptId: top.conceptId,
        conceptName: top.canonicalName,
      },
    });
  }

  if (inputs.dueForReviewCount > 0) {
    insights.push({
      code: 'reviews_due',
      message:
        inputs.dueForReviewCount === 1
          ? '1 concept is due for a spaced review — a quick session keeps it fresh.'
          : `${inputs.dueForReviewCount} concepts are due for a spaced review — a quick session keeps them fresh.`,
      action: { kind: 'adaptive_session' },
    });
  }

  if (inputs.calibration.overconfidenceSignal) {
    insights.push({
      code: 'check_certain_misses',
      message:
        'A few answers felt certain but missed — worth double-checking those topics rather than moving on.',
      action: { kind: 'adaptive_session' },
    });
  }

  const prioritizationPattern = inputs.errorPatterns.find(
    (p) => p.code === 'prioritization_misses'
  );
  if (prioritizationPattern !== undefined) {
    insights.push({
      code: 'prioritization_practice',
      message:
        'Prioritization questions have been the tricky ones — Who First? drills exactly that.',
      action: { kind: 'study_mode', modeId: 'who_first' },
    });
  }

  if (inputs.simulation.completedCount === 0 && inputs.consistency.attemptsLast30 > 0) {
    insights.push({
      code: 'try_simulation',
      message:
        'You have question practice going — a patient simulation is the next way to test it in context.',
      action: { kind: 'simulation' },
    });
  }

  if (insights.length === 0 && inputs.consistency.attemptsLast30 === 0) {
    insights.push({
      code: 'start_studying',
      message:
        'No practice recorded yet this month — an adaptive session is the best place to start.',
      action: { kind: 'adaptive_session' },
    });
  }

  return insights.slice(0, MAX_INSIGHTS);
}
