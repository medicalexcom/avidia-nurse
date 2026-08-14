/**
 * Deterministic scenario tests for the postop PE case (spec AZ/BA):
 * optimal, delayed, unsafe, incomplete, and duplicate-action branches.
 */

import { applyAction, startState } from '../engine';
import { scoreSession } from '../score';
import { clientView } from '../redact';
import type { PatientState, SimulationEvent } from '../types';
import { postopPeCase } from './postopPe';

const caseDef = postopPeCase;

function run(actionIds: string[]): { state: PatientState; events: SimulationEvent[] } {
  let state = startState(caseDef);
  const events: SimulationEvent[] = [];
  for (const actionId of actionIds) {
    const result = applyAction(caseDef, state, { actionId });
    if (result.rejected) break;
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}

const OPTIMAL = [
  'a_assess_resp',
  'a_obtain_vitals',
  'a_apply_o2',
  'a_notify_provider',
  'a_wait',
  'a_reassess',
];

describe('postop PE — optimal path (spec AZ)', () => {
  it('stabilizes at exactly t=17 with full recovery of oxygenation', () => {
    const { state } = run(OPTIMAL);
    expect(state.completed).toEqual({ outcomeId: 'o_stabilized', atMinutes: 17 });
    expect(state.vitals.spo2).toBe(94); // 87 +4 (O2) +3 (treatment)
    expect(state.vitals.hr).toBe(98);
    expect(state.deteriorationLevel).toBe(0);
    expect(state.observedVitals?.vitals.spo2).toBe(94); // reassess saw the recovery
  });

  it('earns full points and misses no critical actions', () => {
    const { state, events } = run(OPTIMAL);
    const score = scoreSession(caseDef, state, events as unknown as Array<Record<string, unknown>>);
    expect(score.missedCriticalActions).toEqual([]);
    expect(score.unsafeActionsTaken).toEqual([]);
    const missed = score.entries.filter((entry) => !entry.earned).map((entry) => entry.id);
    // Everything except the leg assessment cue (not part of this minimal path).
    expect(missed).toEqual(['s_cue_calf']);
    expect(score.earned).toBe(score.possible - 2);
  });

  it('the run is identical every time (deterministic — spec AZ)', () => {
    const a = run(OPTIMAL);
    const b = run(OPTIMAL);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });
});

describe('postop PE — delayed path (spec AZ/BA)', () => {
  it('deteriorates stepwise and ends o_deteriorated at t=35 when never escalated', () => {
    const { state, events } = run(Array(8).fill('a_wait'));
    expect(state.completed).toEqual({ outcomeId: 'o_deteriorated', atMinutes: 35 });
    expect(state.vitals.spo2).toBe(79); // 87 -4 (t15) -4 (t25)
    expect(state.deteriorationLevel).toBe(2);
    // Deterioration was noticeable, not silent (spec AM): the patient spoke
    // and cyanosis became visible without any assessment.
    expect(events.some((e) => e.type === 'patient_statement')).toBe(true);
    expect(events.some((e) => e.type === 'finding_revealed' && e.findingId === 'f_cyanosis')).toBe(
      true
    );
  });

  it('records the missed critical actions in the score', () => {
    const { state, events } = run(Array(8).fill('a_wait'));
    const score = scoreSession(caseDef, state, events as unknown as Array<Record<string, unknown>>);
    expect(score.missedCriticalActions.map((c) => c.criticalId).sort()).toEqual([
      'ca_escalate',
      'ca_o2',
      'ca_vitals',
    ]);
    expect(score.entries.find((e) => e.id === 's_outcome')?.earned).toBe(false);
  });
});

describe('postop PE — unsafe path (spec BA/R)', () => {
  it('ambulating a hypoxemic patient after deterioration causes acute decompensation', () => {
    const { state } = run([...Array(5).fill('a_wait'), 'a_ambulate']);
    expect(state.completed).toEqual({ outcomeId: 'o_complication', atMinutes: 29 });
    expect(state.vitals.spo2).toBe(73);
  });

  it('the unsafe action is recorded and scored without shaming (spec R)', () => {
    const { state, events } = run([...Array(5).fill('a_wait'), 'a_ambulate']);
    const score = scoreSession(caseDef, state, events as unknown as Array<Record<string, unknown>>);
    expect(score.unsafeActionsTaken).toEqual([
      { actionId: 'a_ambulate', classification: 'unsafe' },
    ]);
    expect(score.entries.find((e) => e.id === 's_no_unsafe')?.earned).toBe(false);
  });
});

describe('postop PE — timeout and incomplete branches (spec BA)', () => {
  it('times out at t=49 when stabilized but never reassessed', () => {
    const { state } = run([
      'a_assess_resp',
      'a_obtain_vitals',
      'a_apply_o2',
      'a_notify_provider',
      ...Array(8).fill('a_wait'),
    ]);
    expect(state.completed).toEqual({ outcomeId: 'o_timeout', atMinutes: 49 });
  });

  it('an incomplete session simply has no outcome yet (resumable — spec X)', () => {
    const { state } = run(['a_assess_resp', 'a_obtain_vitals']);
    expect(state.completed).toBeNull();
    expect(state.timeMinutes).toBe(4);
    // …and applying the remaining optimal actions still stabilizes.
    let resumed = state;
    for (const actionId of ['a_apply_o2', 'a_notify_provider', 'a_wait', 'a_reassess']) {
      resumed = applyAction(caseDef, resumed, { actionId }).state;
    }
    expect(resumed.completed?.outcomeId).toBe('o_stabilized');
  });
});

describe('postop PE — duplicate actions (spec Y/BA)', () => {
  it('applying oxygen twice does not double its effect', () => {
    const once = run(['a_apply_o2']);
    const twice = run(['a_apply_o2', 'a_apply_o2']);
    expect(twice.state.vitals.spo2).toBe(once.state.vitals.spo2);
    expect(twice.state.firedRules.filter((id) => id === 'r_o2')).toHaveLength(1);
  });

  it('notifying twice schedules stabilization only once', () => {
    const { state } = run(['a_notify_provider', 'a_notify_provider']);
    expect(state.scheduled.filter((s) => s.scheduleId === 'sch_stabilize')).toHaveLength(1);
  });
});

describe('postop PE — hidden information (spec N)', () => {
  it('never exposes unrevealed findings, true vitals, or phase in the client view', () => {
    const { state } = run(['a_obtain_vitals', 'a_wait', 'a_wait', 'a_wait']);
    const view = clientView(caseDef, state);
    const payload = JSON.stringify(view);
    // Calf swelling is present but was never assessed → must not leak.
    expect(payload).not.toContain('calf is swollen');
    expect(payload).not.toContain('keyCue');
    expect(payload).not.toContain('deteriorationLevel');
    expect(payload).not.toContain('safetyFlags');
    // The observed snapshot is the stale t=2 reading, not the true worsened vitals.
    expect(view.observedVitals?.vitals.spo2).toBe(87);
    expect(state.vitals.spo2).toBe(83);
    expect((view as unknown as Record<string, unknown>).phase).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).vitals).toBeUndefined();
  });
});
