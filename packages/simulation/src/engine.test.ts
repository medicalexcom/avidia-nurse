/**
 * Engine semantics tests (spec AZ/BB): every mechanism the SQL mirror must
 * reproduce is pinned here.
 */

import { applyAction, startState } from './engine';
import { makeTestCase } from './testCase.fixture';
import type { PatientState, SimulationEvent, SubmittedAction } from './types';
import { PHYSIOLOGIC_BOUNDS, SIMULATION_ENGINE_VERSION, VITAL_KEYS } from './types';

const caseDef = makeTestCase();

function run(actions: Array<string | SubmittedAction>): {
  state: PatientState;
  events: SimulationEvent[];
} {
  let state = startState(caseDef);
  const events: SimulationEvent[] = [];
  for (const entry of actions) {
    const submitted = typeof entry === 'string' ? { actionId: entry } : entry;
    const result = applyAction(caseDef, state, submitted);
    expect(result.rejected).toBeNull();
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}

describe('startState', () => {
  it('builds the initial state from the case definition', () => {
    const state = startState(caseDef);
    expect(state.engineVersion).toBe(SIMULATION_ENGINE_VERSION);
    expect(state.caseId).toBe('test_case');
    expect(state.caseVersion).toBe(1);
    expect(state.phase).toBe('p1');
    expect(state.timeMinutes).toBe(0);
    expect(state.vitals).toEqual({ hr: 100, spo2: 90 });
    expect(state.observedVitals).toBeNull();
    expect(state.findings).toEqual({
      f_a: { present: true, revealed: false },
      f_b: { present: false, revealed: false },
      f_c: { present: true, revealed: false },
    });
    expect(state.labs.lab_x).toEqual({ released: false, value: 5, flag: 'high' });
    expect(state.completed).toBeNull();
  });
});

describe('applyAction basics', () => {
  it('is pure: the input state is never mutated', () => {
    const state = startState(caseDef);
    const snapshot = JSON.parse(JSON.stringify(state));
    applyAction(caseDef, state, { actionId: 'act_boost' });
    expect(state).toEqual(snapshot);
  });

  it('advances simulated time by the action cost (spec H)', () => {
    const { state } = run(['act_assess', 'act_wait']);
    expect(state.timeMinutes).toBe(7);
  });

  it('zero-cost actions do not advance time', () => {
    const { state } = run(['act_free']);
    expect(state.timeMinutes).toBe(0);
  });

  it('rejects unknown actions without changing state', () => {
    const state = startState(caseDef);
    const result = applyAction(caseDef, state, { actionId: 'nope' });
    expect(result.rejected).toBe('unknown_action');
    expect(result.state).toBe(state);
    expect(result.events).toEqual([]);
  });

  it('rejects ask_patient without a prompt id', () => {
    const state = startState(caseDef);
    expect(applyAction(caseDef, state, { actionId: 'act_ask' }).rejected).toBe(
      'missing_prompt_param'
    );
    expect(
      applyAction(caseDef, state, { actionId: 'act_ask', params: { promptId: 'nope' } }).rejected
    ).toBe('unknown_prompt');
  });

  it('rejects every action once the simulation is completed (spec BB)', () => {
    const { state } = run(['act_end']);
    expect(state.completed).toEqual({ outcomeId: 'o_done', atMinutes: 1 });
    const result = applyAction(caseDef, state, { actionId: 'act_vitals' });
    expect(result.rejected).toBe('simulation_completed');
    expect(result.state).toBe(state);
  });
});

describe('observation and hidden information (spec M/N)', () => {
  it('obtain_vitals snapshots the TRUE vitals at that moment only', () => {
    const { state } = run(['act_vitals']);
    expect(state.observedVitals).toEqual({ vitals: { hr: 100, spo2: 90 }, atMinutes: 1 });
  });

  it('an old snapshot does not update as true vitals change', () => {
    const { state } = run(['act_vitals', 'act_boost']);
    expect(state.vitals.spo2).toBe(93);
    expect(state.observedVitals?.vitals.spo2).toBe(90);
  });

  it('focused assessment reveals only PRESENT findings in the chosen system', () => {
    const { state, events } = run(['act_assess']);
    expect(state.findings.f_a?.revealed).toBe(true);
    expect(state.findings.f_b?.revealed).toBe(false);
    expect(state.findings.f_c?.revealed).toBe(false); // other system untouched
    const revealed = events.filter((e) => e.type === 'finding_revealed');
    expect(revealed).toHaveLength(1);
  });

  it('assessing a system with nothing present reports no new findings', () => {
    const { events } = run(['act_assess_gu']);
    expect(events.some((e) => e.type === 'no_new_findings')).toBe(true);
  });

  it('gates dialogue responses until the required finding is revealed', () => {
    const before = run([{ actionId: 'act_ask', params: { promptId: 'dp_q' } }]);
    const gated = before.events.find((e) => e.type === 'dialogue');
    expect(gated && gated.type === 'dialogue' ? gated.response : null).toBe('Gated answer.');

    const after = run(['act_assess', { actionId: 'act_ask', params: { promptId: 'dp_q' } }]);
    const full = after.events.filter((e) => e.type === 'dialogue')[0];
    expect(full && full.type === 'dialogue' ? full.response : null).toBe('Full answer.');
  });
});

describe('rules, schedules, phases (spec D/G/P)', () => {
  it('action-triggered rules apply effects, change phase, release labs, and emit statements', () => {
    const { state, events } = run(['act_boost']);
    expect(state.vitals.spo2).toBe(93); // 90 + 5 clamped to effect max 93
    expect(state.phase).toBe('p2');
    expect(state.safetyFlags).toContain('entered_p2'); // phase_enter rule fired
    expect(state.labs.lab_x?.released).toBe(true);
    expect(events.some((e) => e.type === 'lab_released')).toBe(true);
    expect(events.some((e) => e.type === 'patient_statement')).toBe(true);
    expect(state.scheduled).toEqual([
      { scheduleId: 'sch_later', atMinutes: 6, effects: expect.any(Array) },
    ]);
  });

  it('once-rules fire at most once — duplicate actions have no repeat effect (spec Y/BA)', () => {
    const single = run(['act_boost']);
    const double = run(['act_boost', 'act_boost']);
    expect(double.state.vitals.spo2).toBe(single.state.vitals.spo2);
    expect(double.state.firedRules.filter((id) => id === 'r_boost')).toHaveLength(1);
  });

  it('scheduled effects fire when due, even mid-wait', () => {
    const { state } = run(['act_boost', 'act_wait']); // boost t1, schedule t6, wait → t6
    expect(state.timeMinutes).toBe(6);
    expect(state.vitals.hr).toBe(90);
    expect(state.scheduled).toEqual([]);
  });

  it('scheduled effects do not fire early', () => {
    const { state } = run(['act_boost', 'act_vitals']); // t2 < 6
    expect(state.vitals.hr).toBe(100);
    expect(state.scheduled).toHaveLength(1);
  });

  it('cancel_scheduled removes a pending schedule before it fires', () => {
    const { state } = run(['act_boost', 'act_cancel', 'act_wait', 'act_wait']);
    // t=12: r_time10 fired (+10) but the cancelled -10 schedule did NOT.
    expect(state.vitals.hr).toBe(110);
    expect(state.scheduled).toEqual([]);
  });

  it('time-triggered rules fire exactly once when their time arrives', () => {
    const { state } = run(['act_wait', 'act_wait', 'act_wait']); // t15 ≥ 10
    expect(state.vitals.hr).toBe(110);
    expect(state.firedRules).toContain('r_time10');
    const again = applyAction(caseDef, state, { actionId: 'act_wait' });
    expect(again.state.vitals.hr).toBe(110);
  });

  it('classification honors byPhase overrides (spec R)', () => {
    const { state } = run(['act_class', 'act_boost', 'act_class']);
    const entries = state.actionLog.filter((e) => e.actionId === 'act_class');
    expect(entries.map((e) => e.classification)).toEqual(['appropriate', 'unsafe']);
  });
});

describe('bounds and termination (spec J/BB)', () => {
  it('clamps vitals to hard physiologic bounds regardless of rule deltas', () => {
    const { state } = run(['act_crash']);
    expect(state.vitals.spo2).toBe(PHYSIOLOGIC_BOUNDS.spo2.min);
  });

  it('never produces a vital outside bounds in any event either', () => {
    const { events } = run(['act_crash', 'act_boost', 'act_wait']);
    for (const event of events) {
      if (event.type === 'vital_change') {
        const bounds = PHYSIOLOGIC_BOUNDS[event.vital];
        expect(event.to).toBeGreaterThanOrEqual(bounds.min);
        expect(event.to).toBeLessThanOrEqual(bounds.max);
      }
    }
    expect(VITAL_KEYS.length).toBeGreaterThan(0);
  });

  it('an end effect clears schedules and stops all further processing', () => {
    const { state } = run(['act_boost', 'act_end']);
    expect(state.completed?.outcomeId).toBe('o_done');
    expect(state.scheduled).toEqual([]);
  });

  it('the time deadline ends the simulation even under pure waiting', () => {
    let state = startState(caseDef);
    for (let i = 0; i < 12; i += 1) {
      const result = applyAction(caseDef, state, { actionId: 'act_wait' });
      if (result.rejected) break;
      state = result.state;
    }
    expect(state.completed?.outcomeId).toBe('o_timeout');
    expect(state.completed?.atMinutes).toBe(60);
  });

  it('simulated time is monotonically non-decreasing (spec BB)', () => {
    let state = startState(caseDef);
    let last = 0;
    for (const actionId of ['act_free', 'act_vitals', 'act_assess', 'act_wait', 'act_boost']) {
      state = applyAction(caseDef, state, { actionId }).state;
      expect(state.timeMinutes).toBeGreaterThanOrEqual(last);
      last = state.timeMinutes;
    }
  });
});

describe('events (spec I)', () => {
  it('tags every event with an explicit visibility flag', () => {
    const { events } = run(['act_assess', 'act_boost', 'act_crash', 'act_end']);
    for (const event of events) {
      expect(typeof event.visible).toBe('boolean');
    }
    expect(events.some((e) => e.visible === false && e.type === 'action_classified')).toBe(true);
    expect(events.some((e) => e.visible === false && e.type === 'rule_fired')).toBe(true);
    expect(events.some((e) => e.visible === true && e.type === 'completed')).toBe(true);
  });

  it('records the action itself with post-advance timing', () => {
    const { events } = run(['act_assess']);
    const accepted = events.find((e) => e.type === 'action_accepted');
    expect(accepted?.atMinutes).toBe(2);
  });
});
