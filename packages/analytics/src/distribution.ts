/**
 * Mastery distribution — M12 (spec E).
 *
 * Counts course concepts by the FIVE M8 states, resolved by the
 * authoritative `masteryState` function from @avidia/mastery — never a
 * re-implementation (core principle: M12 is not a second mastery engine).
 * Concepts with no mastery row count as 'unassessed' (spec H: unassessed is
 * never "weak"). Counts are integers; no decimals to invent (spec E).
 */

import { masteryState } from '@avidia/mastery';
import type { MasteryState } from '@avidia/domain';
import type { ConceptRecord, MasteryDistribution, MasteryRecord } from './types';

export interface DistributionResult {
  distribution: MasteryDistribution;
  totalConcepts: number;
  assessedConcepts: number;
  /** Assessed fraction of the course in [0, 1], or null with no concepts. */
  assessedCoverage: number | null;
}

export function computeDistribution(
  concepts: readonly ConceptRecord[],
  mastery: readonly MasteryRecord[],
  now: Date
): DistributionResult {
  const byConcept = new Map(mastery.map((m) => [m.conceptId, m.aggregate]));
  const distribution: MasteryDistribution = {
    unassessed: 0,
    needs_review: 0,
    developing: 0,
    strong: 0,
    due_for_review: 0,
  };
  for (const concept of concepts) {
    const state: MasteryState = masteryState(byConcept.get(concept.conceptId) ?? null, now);
    distribution[state] += 1;
  }
  const totalConcepts = concepts.length;
  const assessedConcepts = totalConcepts - distribution.unassessed;
  return {
    distribution,
    totalConcepts,
    assessedConcepts,
    assessedCoverage: totalConcepts > 0 ? assessedConcepts / totalConcepts : null,
  };
}
