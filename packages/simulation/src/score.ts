/**
 * Deterministic simulation scoring — M11 (spec S/AQ/AS).
 *
 * Scoring is an evaluation of the recorded session against the case's
 * explicit scoring entries — never an LLM judgment. Each entry names a
 * clinical-judgment dimension (NCSBN CJMM — Playbook §18), a point value,
 * and a machine-checkable criterion; the result is fully explainable: every
 * earned and missed entry carries its student-facing label.
 *
 * Mirrored by the SQL scorer in migration 0011 (same double-maintenance
 * contract as ADR-0020); tests here pin the semantics.
 */

import {
  CJMM_DIMENSIONS,
  type ActionClassification,
  type CjmmDimension,
  type PatientState,
  type ScoringCriterion,
  type SimulationCaseDefinition,
} from './types';

export interface DimensionScore {
  earned: number;
  possible: number;
}

export interface ScoredEntry {
  id: string;
  dimension: CjmmDimension;
  points: number;
  earned: boolean;
  label: string;
}

export interface SimulationScore {
  algorithmVersion: number;
  dimensions: Record<CjmmDimension, DimensionScore>;
  entries: ScoredEntry[];
  earned: number;
  possible: number;
  missedCriticalActions: Array<{ criticalId: string; label: string }>;
  unsafeActionsTaken: Array<{ actionId: string; classification: ActionClassification }>;
}

/** Version of the scoring semantics; bump with the SQL mirror (spec AY). */
export const SIMULATION_SCORE_VERSION = 1;

const UNSAFE: ActionClassification[] = ['unsafe', 'contraindicated'];

function findingRevealedAt(
  state: PatientState,
  events: Array<{ type: string; findingId?: string; atMinutes?: number }>,
  findingId: string
): number | null {
  for (const event of events) {
    if (event.type === 'finding_revealed' && event.findingId === findingId) {
      return event.atMinutes ?? 0;
    }
  }
  return null;
}

function criterionMet(
  caseDef: SimulationCaseDefinition,
  state: PatientState,
  events: Array<Record<string, unknown>>,
  criterion: ScoringCriterion
): boolean {
  switch (criterion.kind) {
    case 'critical_action_done': {
      return state.actionLog.some(
        (entry) =>
          entry.actionId === criterion.actionId &&
          (criterion.byMinutes === undefined || entry.atMinutes <= criterion.byMinutes)
      );
    }
    case 'any_action_done': {
      return state.actionLog.some(
        (entry) =>
          criterion.actionIds.includes(entry.actionId) &&
          (criterion.byMinutes === undefined || entry.atMinutes <= criterion.byMinutes)
      );
    }
    case 'cue_revealed': {
      const at = findingRevealedAt(
        state,
        events as Array<{ type: string; findingId?: string; atMinutes?: number }>,
        criterion.findingId
      );
      return at !== null && (criterion.byMinutes === undefined || at <= criterion.byMinutes);
    }
    case 'vitals_obtained': {
      return state.actionLog.some((entry) => {
        const action = caseDef.actions.find((a) => a.id === entry.actionId);
        return (
          action?.observesVitals === true &&
          (criterion.byMinutes === undefined || entry.atMinutes <= criterion.byMinutes)
        );
      });
    }
    case 'no_unsafe_actions': {
      return !state.actionLog.some((entry) => UNSAFE.includes(entry.classification));
    }
    case 'action_not_done': {
      return !state.actionLog.some((entry) => entry.actionId === criterion.actionId);
    }
    case 'reassessed_after': {
      const target = state.actionLog.find((entry) => entry.actionId === criterion.actionId);
      if (!target) return false;
      return state.actionLog.some((entry) => {
        if (entry.atMinutes <= target.atMinutes) return false;
        if (entry.atMinutes > target.atMinutes + criterion.withinMinutes) return false;
        const action = caseDef.actions.find((a) => a.id === entry.actionId);
        return (
          action !== undefined &&
          (action.observesVitals === true || action.type === 'assess' || action.type === 'reassess')
        );
      });
    }
    case 'outcome_is': {
      return state.completed?.outcomeId === criterion.outcomeId;
    }
  }
}

/**
 * Score a completed (or ended) session from its final state and the full
 * event record (spec S). Deterministic and explainable — never a percentage
 * dressed up as a prediction (spec on honest results).
 */
export function scoreSession(
  caseDef: SimulationCaseDefinition,
  state: PatientState,
  events: Array<Record<string, unknown>>
): SimulationScore {
  const dimensions = {} as Record<CjmmDimension, DimensionScore>;
  for (const dimension of CJMM_DIMENSIONS) {
    dimensions[dimension] = { earned: 0, possible: 0 };
  }
  const entries: ScoredEntry[] = [];
  let earned = 0;
  let possible = 0;
  for (const entry of caseDef.scoring) {
    const met = criterionMet(caseDef, state, events, entry.criterion);
    dimensions[entry.dimension].possible += entry.points;
    possible += entry.points;
    if (met) {
      dimensions[entry.dimension].earned += entry.points;
      earned += entry.points;
    }
    entries.push({
      id: entry.id,
      dimension: entry.dimension,
      points: entry.points,
      earned: met,
      label: entry.label,
    });
  }
  const missedCriticalActions = caseDef.criticalActions
    .filter(
      (critical) =>
        !state.actionLog.some(
          (entry) =>
            critical.anyOfActionIds.includes(entry.actionId) &&
            (critical.byMinutes === undefined || entry.atMinutes <= critical.byMinutes)
        )
    )
    .map((critical) => ({ criticalId: critical.id, label: critical.label }));
  const unsafeActionsTaken = state.actionLog
    .filter((entry) => UNSAFE.includes(entry.classification))
    .map((entry) => ({ actionId: entry.actionId, classification: entry.classification }));
  return {
    algorithmVersion: SIMULATION_SCORE_VERSION,
    dimensions,
    entries,
    earned,
    possible,
    missedCriticalActions,
    unsafeActionsTaken,
  };
}
