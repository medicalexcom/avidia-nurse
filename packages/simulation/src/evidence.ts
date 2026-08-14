/**
 * Simulation → M8 mastery evidence — M11 (spec T/U).
 *
 * There is exactly ONE mastery model (spec T): a completed simulation is
 * normalized into the same PerformanceEvent shape M8 consumes for question
 * attempts, one bounded event per mapped concept — never a parallel
 * "simulation mastery". The mapping is deterministic: a concept's evidence
 * is correct when the student earned at least EVIDENCE_CORRECT_THRESHOLD of
 * the points in that concept's mapped clinical-judgment dimensions.
 *
 * Applied transactionally at session completion by the SQL RPC (migration
 * 0011) using the SAME versioned v1 mastery constants as question attempts
 * (ADR-0022) — centralized evidence weighting, nothing bespoke.
 */

import type { PerformanceEvent } from '@avidia/mastery';

import type { SimulationCaseDefinition } from './types';
import type { SimulationScore } from './score';

/** Minimum earned-points ratio across mapped dimensions to count correct. */
export const EVIDENCE_CORRECT_THRESHOLD = 0.65;

export interface SimulationEvidenceItem {
  conceptName: string;
  conceptKey: string;
  /** Earned/possible over the mapped dimensions (explainability). */
  earned: number;
  possible: number;
  event: PerformanceEvent;
}

/**
 * Normalize a scored session into M8 evidence items (spec U). Concepts whose
 * mapped dimensions carry no scoreable points yield NO evidence — silence is
 * more honest than invented signal.
 */
export function simulationEvidence(
  caseDef: SimulationCaseDefinition,
  score: SimulationScore,
  completedAtIso: string
): SimulationEvidenceItem[] {
  const items: SimulationEvidenceItem[] = [];
  for (const mapping of caseDef.conceptMappings) {
    let earned = 0;
    let possible = 0;
    for (const dimension of mapping.dimensions) {
      earned += score.dimensions[dimension].earned;
      possible += score.dimensions[dimension].possible;
    }
    if (possible <= 0) continue;
    items.push({
      conceptName: mapping.conceptName,
      conceptKey: mapping.conceptKey,
      earned,
      possible,
      event: {
        isCorrect: earned / possible >= EVIDENCE_CORRECT_THRESHOLD,
        difficulty: mapping.difficulty,
        cognitiveLevel: mapping.cognitiveLevel,
        confidence: null,
        answeredAt: completedAtIso,
      },
    });
  }
  return items;
}
