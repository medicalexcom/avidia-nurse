/**
 * Property/invariant tests (spec BB): seeded random walks over every
 * built-in case. The seeds make the walks reproducible; the invariants are
 * the contract the SQL mirror must also uphold.
 */

import { applyAction, startState } from './engine';
import { clientView } from './redact';
import { replayActions } from './replay';
import { BUILTIN_CASES } from './cases';
import type { PatientState, SimulationCaseDefinition, SubmittedAction } from './types';
import { PHYSIOLOGIC_BOUNDS, VITAL_KEYS } from './types';

/** Deterministic LCG so every walk is reproducible from its seed. */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomAction(caseDef: SimulationCaseDefinition, rand: () => number): SubmittedAction {
  const action = caseDef.actions[Math.floor(rand() * caseDef.actions.length)]!;
  if (action.promptRequired) {
    const prompt = caseDef.dialogue[Math.floor(rand() * caseDef.dialogue.length)]!;
    return { actionId: action.id, params: { promptId: prompt.id } };
  }
  return { actionId: action.id };
}

function assertInvariants(caseDef: SimulationCaseDefinition, state: PatientState): void {
  for (const vital of VITAL_KEYS) {
    const value = state.vitals[vital];
    if (value === undefined) continue;
    expect(value).toBeGreaterThanOrEqual(PHYSIOLOGIC_BOUNDS[vital].min);
    expect(value).toBeLessThanOrEqual(PHYSIOLOGIC_BOUNDS[vital].max);
  }
  // Once-rules never fire twice.
  expect(new Set(state.firedRules).size).toBe(state.firedRules.length);
  // The action log is strictly sequential with non-decreasing time.
  state.actionLog.forEach((entry, index) => {
    expect(entry.seq).toBe(index + 1);
    if (index > 0)
      expect(entry.atMinutes).toBeGreaterThanOrEqual(state.actionLog[index - 1]!.atMinutes);
  });
  // Hidden findings never leak into the client view (spec N).
  const view = JSON.stringify(clientView(caseDef, state));
  for (const finding of caseDef.findings) {
    if (state.findings[finding.id]?.revealed !== true) {
      expect(view).not.toContain(finding.text);
    }
  }
}

const WALKS = 25;
const STEPS = 40;

describe.each(BUILTIN_CASES.map((c) => [c.caseId, c] as const))(
  'random walks — %s',
  (_id, caseDef) => {
    it('upholds every invariant across seeded random walks (spec BB)', () => {
      for (let walk = 0; walk < WALKS; walk += 1) {
        const rand = makeRandom(walk * 7919 + 17);
        let state = startState(caseDef);
        const accepted: SubmittedAction[] = [];
        let lastTime = 0;
        for (let step = 0; step < STEPS; step += 1) {
          const submitted = randomAction(caseDef, rand);
          const result = applyAction(caseDef, state, submitted);
          if (result.rejected === 'simulation_completed') {
            // Completed sessions reject every further action, forever.
            expect(state.completed).not.toBeNull();
            expect(result.state).toBe(state);
            break;
          }
          if (result.rejected !== null) continue;
          accepted.push(submitted);
          state = result.state;
          expect(state.timeMinutes).toBeGreaterThanOrEqual(lastTime);
          lastTime = state.timeMinutes;
          assertInvariants(caseDef, state);
        }
        // Determinism: replaying the accepted history reproduces the state.
        const replayed = replayActions(caseDef, accepted);
        expect(JSON.stringify(replayed.state)).toBe(JSON.stringify(state));
      }
    });

    it('cannot run forever: pure waiting always terminates (spec BB)', () => {
      const waitAction = caseDef.actions.find((a) => a.type === 'wait');
      expect(waitAction).toBeDefined();
      let state = startState(caseDef);
      for (let i = 0; i < 30 && !state.completed; i += 1) {
        const result = applyAction(caseDef, state, { actionId: waitAction!.id });
        if (result.rejected) break;
        state = result.state;
      }
      expect(state.completed).not.toBeNull();
    });
  }
);
