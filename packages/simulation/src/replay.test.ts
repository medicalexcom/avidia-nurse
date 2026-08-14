/**
 * Replay tests (spec W/AR/AZ): the persisted action history plus the case
 * definition fully reconstructs the session — states, events, and rejections.
 */

import { applyAction, startState } from './engine';
import { replayActions } from './replay';
import { postopPeCase } from './cases';
import type { PatientState, SimulationEvent, SubmittedAction } from './types';

const OPTIMAL: SubmittedAction[] = [
  { actionId: 'a_assess_resp' },
  { actionId: 'a_obtain_vitals' },
  { actionId: 'a_apply_o2' },
  { actionId: 'a_notify_provider' },
  { actionId: 'a_wait' },
  { actionId: 'a_reassess' },
];

describe('replayActions', () => {
  it('reconstructs exactly the state and events of the original run (spec W)', () => {
    let state: PatientState = startState(postopPeCase);
    const events: SimulationEvent[] = [];
    for (const action of OPTIMAL) {
      const result = applyAction(postopPeCase, state, action);
      state = result.state;
      events.push(...result.events);
    }
    const replayed = replayActions(postopPeCase, OPTIMAL);
    expect(replayed.state).toEqual(state);
    expect(replayed.events).toEqual(events);
    expect(replayed.steps).toHaveLength(OPTIMAL.length);
  });

  it('produces a per-step timeline suitable for debrief replay (spec AR)', () => {
    const replayed = replayActions(postopPeCase, OPTIMAL);
    const times = replayed.steps.map((step) => step.result.state.timeMinutes);
    expect(times).toEqual([2, 4, 6, 9, 14, 17]);
    expect(replayed.steps.at(-1)?.result.state.completed?.outcomeId).toBe('o_stabilized');
  });

  it('skips rejected actions without corrupting the timeline', () => {
    const withJunk: SubmittedAction[] = [
      OPTIMAL[0]!,
      { actionId: 'not_a_real_action' },
      ...OPTIMAL.slice(1),
    ];
    const replayed = replayActions(postopPeCase, withJunk);
    expect(replayed.steps[1]!.result.rejected).toBe('unknown_action');
    expect(replayed.state.completed?.outcomeId).toBe('o_stabilized');
    expect(replayed.state.timeMinutes).toBe(17);
  });

  it('actions after completion replay as rejections, not mutations (spec X/BB)', () => {
    const replayed = replayActions(postopPeCase, [...OPTIMAL, { actionId: 'a_obtain_vitals' }]);
    expect(replayed.steps.at(-1)?.result.rejected).toBe('simulation_completed');
    expect(replayed.state.completed).toEqual({ outcomeId: 'o_stabilized', atMinutes: 17 });
  });

  it('is deterministic across replays (spec AZ)', () => {
    const a = replayActions(postopPeCase, OPTIMAL);
    const b = replayActions(postopPeCase, OPTIMAL);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
