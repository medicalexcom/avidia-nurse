/**
 * Deterministic scenario tests for the hypoglycemia case (spec AZ/BA):
 * optimal, crisis-recovery, unsafe (insulin, oral carbs in crisis),
 * untreated, and duplicate-action branches.
 */

import { applyAction, startState } from '../engine';
import { scoreSession } from '../score';
import type { PatientState, SimulationEvent, SubmittedAction } from '../types';
import { hypoglycemiaCase } from './hypoglycemia';

const caseDef = hypoglycemiaCase;

function run(entries: Array<string | SubmittedAction>): {
  state: PatientState;
  events: SimulationEvent[];
} {
  let state = startState(caseDef);
  const events: SimulationEvent[] = [];
  for (const entry of entries) {
    const submitted = typeof entry === 'string' ? { actionId: entry } : entry;
    const result = applyAction(caseDef, state, submitted);
    if (result.rejected) break;
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}

const OPTIMAL = ['a_check_glucose', 'a_assess_neuro', 'a_give_oral_carbs', 'a_recheck_glucose'];

describe('hypoglycemia — optimal path (spec AZ)', () => {
  it('resolves at t=22 after check → treat → 15-minute recheck', () => {
    const { state } = run(OPTIMAL);
    expect(state.completed).toEqual({ outcomeId: 'o_resolved', atMinutes: 22 });
    expect(state.vitals.glucose).toBe(93); // 48 + 45
    expect(state.phase).toBe('recovering');
    expect(state.observedVitals?.vitals.glucose).toBe(93); // recheck verified it
    expect(state.deteriorationLevel).toBe(0);
  });

  it('earns every point on the optimal path', () => {
    const { state, events } = run(OPTIMAL);
    const score = scoreSession(caseDef, state, events as unknown as Array<Record<string, unknown>>);
    expect(score.earned).toBe(score.possible);
    expect(score.missedCriticalActions).toEqual([]);
    expect(score.unsafeActionsTaken).toEqual([]);
  });
});

describe('hypoglycemia — crisis branch (spec BA/D)', () => {
  const TO_CRISIS = ['a_wait', 'a_wait', 'a_wait', 'a_wait']; // t=20

  it('progresses to an unresponsive crisis when untreated past t=18', () => {
    const { state, events } = run(TO_CRISIS);
    expect(state.phase).toBe('crisis');
    expect(state.vitals.glucose).toBe(32);
    expect(state.deteriorationLevel).toBe(2);
    // Progressive, noticeable deterioration (spec AM): confusion first…
    expect(events.some((e) => e.type === 'finding_revealed' && e.findingId === 'f_confusion')).toBe(
      true
    );
    // …then unresponsiveness, both visible without any assessment.
    expect(
      events.some((e) => e.type === 'finding_revealed' && e.findingId === 'f_unresponsive')
    ).toBe(true);
  });

  it('oral carbs become UNSAFE in crisis (phase-dependent classification — spec F/R)', () => {
    const { state } = run([...TO_CRISIS, 'a_give_oral_carbs']);
    const entry = state.actionLog.find((e) => e.actionId === 'a_give_oral_carbs');
    expect(entry?.classification).toBe('unsafe');
    expect(state.safetyFlags).toContain('aspiration_event');
    expect(state.vitals.spo2).toBe(91); // aspiration consequence, not a lecture
    expect(state.safetyFlags).not.toContain('treated'); // and it did not treat
  });

  it('IV dextrose recovers the crisis and the recheck confirms it', () => {
    const { state } = run([...TO_CRISIS, 'a_give_iv_dextrose', 'a_recheck_glucose']);
    expect(state.completed?.outcomeId).toBe('o_resolved');
    expect(state.vitals.glucose).toBe(152); // 32 + 120
    expect(state.findings.f_unresponsive?.present).toBe(false);
    expect(state.phase).toBe('recovering');
  });
});

describe('hypoglycemia — unsafe and failure branches (spec BA)', () => {
  it('administering insulin drives glucose to a seizure (o_complication)', () => {
    const { state } = run(['a_check_glucose', 'a_give_insulin']);
    expect(state.completed).toEqual({ outcomeId: 'o_complication', atMinutes: 4 });
    expect(state.vitals.glucose).toBe(18); // 48 - 30
  });

  it('the contraindicated insulin shows up in the score', () => {
    const { state, events } = run(['a_check_glucose', 'a_give_insulin']);
    const score = scoreSession(caseDef, state, events as unknown as Array<Record<string, unknown>>);
    expect(score.unsafeActionsTaken).toEqual([
      { actionId: 'a_give_insulin', classification: 'contraindicated' },
    ]);
    expect(score.entries.find((e) => e.id === 's_no_insulin')?.earned).toBe(false);
    expect(score.entries.find((e) => e.id === 's_no_unsafe')?.earned).toBe(false);
  });

  it('never treating ends o_deteriorated at t=40', () => {
    const { state } = run(Array(8).fill('a_wait'));
    expect(state.completed).toEqual({ outcomeId: 'o_deteriorated', atMinutes: 40 });
  });
});

describe('hypoglycemia — duplicates and dialogue (spec Y/AG)', () => {
  it('giving oral carbs twice does not double-correct the glucose', () => {
    const once = run(['a_give_oral_carbs']);
    const twice = run(['a_give_oral_carbs', 'a_give_oral_carbs']);
    expect(twice.state.vitals.glucose).toBe(once.state.vitals.glucose);
  });

  it('scripted dialogue is deterministic and grounded in the case (spec AG/AH)', () => {
    const { events } = run([{ actionId: 'a_ask_patient', params: { promptId: 'dp_eaten' } }]);
    const dialogue = events.find((e) => e.type === 'dialogue');
    expect(dialogue && dialogue.type === 'dialogue' ? dialogue.response : null).toContain(
      'Nothing since midnight'
    );
  });
});
