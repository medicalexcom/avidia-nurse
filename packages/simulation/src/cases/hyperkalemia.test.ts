/**
 * Deterministic scenario tests for the hyperkalemia medication-safety case
 * (spec AZ/BA): optimal, unsafe-KCl (with and without interception), delayed,
 * timeout, and duplicate-action branches.
 */

import { applyAction, startState } from '../engine';
import { scoreSession } from '../score';
import { clientView } from '../redact';
import type { PatientState, SimulationEvent } from '../types';
import { hyperkalemiaCase } from './hyperkalemia';

const caseDef = hyperkalemiaCase;

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
  'a_assess_cardiac',
  'a_obtain_vitals',
  'a_hold_kcl',
  'a_obtain_ecg',
  'a_notify_provider',
  'a_wait',
  'a_give_treatment',
  'a_reassess',
];

describe('hyperkalemia — optimal path (spec AZ)', () => {
  it('manages the potassium and ends o_managed at t=22', () => {
    const { state } = run(OPTIMAL);
    expect(state.completed).toEqual({ outcomeId: 'o_managed', atMinutes: 22 });
    expect(state.vitals.hr).toBe(66); // 62 + 4 after treatment
    expect(state.labs.lab_k).toEqual({ released: true, value: 5.6, flag: 'high' });
    expect(state.deteriorationLevel).toBe(0);
  });

  it('the critical potassium is chart data, visible from the start (spec K)', () => {
    const view = clientView(caseDef, startState(caseDef));
    const k = view.releasedLabs.find((lab) => lab.id === 'lab_k');
    expect(k).toEqual({
      id: 'lab_k',
      name: 'Potassium',
      value: 6.4,
      unit: 'mEq/L',
      flag: 'critical',
    });
  });

  it('the ECG — not the bedside assessment — reveals the peaked T waves', () => {
    const bedside = run(['a_assess_cardiac']);
    expect(bedside.state.findings.f_peaked_t?.revealed).toBe(false);
    const withEcg = run(['a_obtain_ecg']);
    expect(withEcg.state.findings.f_peaked_t?.revealed).toBe(true);
  });

  it('earns every point on the optimal path', () => {
    const { state, events } = run(OPTIMAL);
    const score = scoreSession(caseDef, state, events as unknown as Array<Record<string, unknown>>);
    expect(score.earned).toBe(score.possible);
    expect(score.missedCriticalActions).toEqual([]);
  });

  it('treatment before new orders arrive is classified premature and has no effect', () => {
    const { state } = run(['a_give_treatment']);
    const entry = state.actionLog.find((e) => e.actionId === 'a_give_treatment');
    expect(entry?.classification).toBe('premature');
    expect(state.safetyFlags).not.toContain('treated');
  });
});

describe('hyperkalemia — the medication error (spec BA/R/Q)', () => {
  it('administering the KCl schedules a cardiac arrest 10 minutes later', () => {
    const { state } = run(['a_give_kcl', 'a_wait', 'a_wait']); // t=2, arrest due t=12
    expect(state.completed).toEqual({ outcomeId: 'o_arrest', atMinutes: 12 });
    expect(state.vitals.hr).toBe(30);
  });

  it('immediate provider notification intercepts the pending arrest', () => {
    const { state } = run(['a_give_kcl', 'a_notify_provider', 'a_wait', 'a_wait', 'a_wait']);
    expect(state.completed).toBeNull(); // arrest cancelled; session continues
    expect(state.scheduled.some((s) => s.scheduleId === 'sch_arrest')).toBe(false);
    expect(state.safetyFlags).toContain('kcl_given');
  });

  it('an intercepted error can still reach o_managed — but the score remembers', () => {
    const { state, events } = run([
      'a_give_kcl',
      'a_notify_provider',
      'a_wait',
      'a_give_treatment',
      'a_reassess',
    ]);
    expect(state.completed?.outcomeId).toBe('o_managed');
    const score = scoreSession(caseDef, state, events as unknown as Array<Record<string, unknown>>);
    expect(score.unsafeActionsTaken).toEqual([
      { actionId: 'a_give_kcl', classification: 'unsafe' },
    ]);
    expect(score.entries.find((e) => e.id === 's_no_kcl')?.earned).toBe(false);
    expect(score.entries.find((e) => e.id === 's_outcome')?.earned).toBe(true);
  });
});

describe('hyperkalemia — delayed and timeout branches (spec BA)', () => {
  it('never escalating ends o_deteriorated at t=45 with progressive bradycardia', () => {
    const { state, events } = run(Array(9).fill('a_wait'));
    expect(state.completed).toEqual({ outcomeId: 'o_deteriorated', atMinutes: 45 });
    expect(state.vitals.hr).toBe(42); // 62 -10 (t15) -10 (t30)
    expect(
      events.some((e) => e.type === 'finding_revealed' && e.findingId === 'f_bradycardia_sx')
    ).toBe(true);
  });

  it('treated but never reassessed times out at t=54', () => {
    const { state } = run([
      'a_assess_cardiac',
      'a_obtain_vitals',
      'a_hold_kcl',
      'a_obtain_ecg',
      'a_notify_provider',
      'a_wait',
      'a_give_treatment',
      ...Array(8).fill('a_wait'),
    ]);
    expect(state.completed).toEqual({ outcomeId: 'o_timeout', atMinutes: 54 });
  });
});

describe('hyperkalemia — duplicates (spec Y/BA)', () => {
  it('holding the KCl twice records twice but flags once', () => {
    const { state } = run(['a_hold_kcl', 'a_hold_kcl']);
    expect(state.actionLog.filter((e) => e.actionId === 'a_hold_kcl')).toHaveLength(2);
    expect(state.safetyFlags.filter((f) => f === 'kcl_held')).toHaveLength(1);
  });

  it('notifying twice schedules the treatment orders only once', () => {
    const { state } = run(['a_notify_provider', 'a_notify_provider']);
    expect(state.scheduled.filter((s) => s.scheduleId === 'sch_orders')).toHaveLength(1);
  });
});
