/**
 * Replay — M11 (spec W/AR/AZ).
 *
 * Because the engine is pure and deterministic, the full session is
 * reconstructible from the case definition plus the ordered action log.
 * This is what makes the persisted action history auditable: the stored
 * states and events are re-derivable, so debugging, review, scoring, and
 * timeline replay never depend on trusting a mutable snapshot.
 */

import { applyAction, startState } from './engine';
import type {
  ApplyResult,
  PatientState,
  SimulationCaseDefinition,
  SimulationEvent,
  SubmittedAction,
} from './types';

export interface ReplayStep {
  action: SubmittedAction;
  result: ApplyResult;
}

export interface ReplayResult {
  state: PatientState;
  events: SimulationEvent[];
  steps: ReplayStep[];
}

/** Re-run an ordered action history from the initial state (spec W/AZ). */
export function replayActions(
  caseDef: SimulationCaseDefinition,
  actions: SubmittedAction[]
): ReplayResult {
  let state = startState(caseDef);
  const events: SimulationEvent[] = [];
  const steps: ReplayStep[] = [];
  for (const action of actions) {
    const result = applyAction(caseDef, state, action);
    steps.push({ action, result });
    if (result.rejected === null) {
      state = result.state;
      events.push(...result.events);
    }
  }
  return { state, events, steps };
}
