/**
 * Scoring semantics tests (spec S/AQ): each criterion kind pinned against a
 * synthetic session — deterministic, explainable, never an LLM judgment.
 */

import { applyAction, startState } from './engine';
import { scoreSession, SIMULATION_SCORE_VERSION } from './score';
import { makeTestCase } from './testCase.fixture';
import type { PatientState, ScoringEntry, SimulationEvent } from './types';
import { CJMM_DIMENSIONS } from './types';

const baseCase = makeTestCase();

function runCase(scoring: ScoringEntry[], actionIds: string[]): ReturnType<typeof scoreSession> {
  const caseDef = { ...baseCase, scoring };
  let state: PatientState = startState(caseDef);
  const events: SimulationEvent[] = [];
  for (const actionId of actionIds) {
    const result = applyAction(caseDef, state, { actionId });
    if (result.rejected) break;
    state = result.state;
    events.push(...result.events);
  }
  return scoreSession(caseDef, state, events as unknown as Array<Record<string, unknown>>);
}

function entry(criterion: ScoringEntry['criterion'], points = 2): ScoringEntry {
  return { id: 's_test', dimension: 'take_action', points, criterion, label: 'Test entry.' };
}

describe('scoreSession structure', () => {
  it('reports the algorithm version and every dimension (spec AY/S)', () => {
    const score = runCase([entry({ kind: 'vitals_obtained' })], ['act_vitals']);
    expect(score.algorithmVersion).toBe(SIMULATION_SCORE_VERSION);
    expect(Object.keys(score.dimensions).sort()).toEqual([...CJMM_DIMENSIONS].sort());
    expect(score.dimensions.take_action).toEqual({ earned: 2, possible: 2 });
    expect(score.earned).toBe(2);
    expect(score.possible).toBe(2);
  });

  it('every entry carries its student-facing label, earned or missed (spec S)', () => {
    const score = runCase([entry({ kind: 'vitals_obtained' })], ['act_wait']);
    expect(score.entries).toEqual([
      { id: 's_test', dimension: 'take_action', points: 2, earned: false, label: 'Test entry.' },
    ]);
  });
});

describe('criterion kinds', () => {
  it('critical_action_done respects the deadline', () => {
    const late = entry({ kind: 'critical_action_done', actionId: 'act_vitals', byMinutes: 3 });
    expect(runCase([late], ['act_vitals']).earned).toBe(2); // t=1 ≤ 3
    expect(runCase([late], ['act_wait', 'act_vitals']).earned).toBe(0); // t=6 > 3
  });

  it('any_action_done accepts any listed action', () => {
    const anyOf = entry({ kind: 'any_action_done', actionIds: ['act_boost', 'act_vitals'] });
    expect(runCase([anyOf], ['act_boost']).earned).toBe(2);
    expect(runCase([anyOf], ['act_vitals']).earned).toBe(2);
    expect(runCase([anyOf], ['act_wait']).earned).toBe(0);
  });

  it('cue_revealed reads the finding_revealed event record', () => {
    const cue = entry({ kind: 'cue_revealed', findingId: 'f_a', byMinutes: 5 });
    expect(runCase([cue], ['act_assess']).earned).toBe(2);
    expect(runCase([cue], ['act_wait']).earned).toBe(0);
    expect(runCase([cue], ['act_wait', 'act_assess']).earned).toBe(0); // t=7 > 5
  });

  it('vitals_obtained counts any observing action', () => {
    const vitals = entry({ kind: 'vitals_obtained' });
    expect(runCase([vitals], ['act_vitals']).earned).toBe(2);
    expect(runCase([vitals], ['act_assess']).earned).toBe(0);
  });

  it('no_unsafe_actions fails on unsafe or contraindicated classifications', () => {
    const safe = entry({ kind: 'no_unsafe_actions' });
    expect(runCase([safe], ['act_vitals']).earned).toBe(2);
    expect(runCase([safe], ['act_crash']).earned).toBe(0);
    // Phase-dependent: act_class is unsafe only in p2.
    expect(runCase([safe], ['act_class']).earned).toBe(2);
    expect(runCase([safe], ['act_boost', 'act_class']).earned).toBe(0);
  });

  it('action_not_done rewards restraint', () => {
    const held = entry({ kind: 'action_not_done', actionId: 'act_crash' });
    expect(runCase([held], ['act_vitals']).earned).toBe(2);
    expect(runCase([held], ['act_crash']).earned).toBe(0);
  });

  it('reassessed_after requires an assessment inside the follow-up window', () => {
    const followUp = entry({ kind: 'reassessed_after', actionId: 'act_boost', withinMinutes: 4 });
    expect(runCase([followUp], ['act_boost', 'act_vitals']).earned).toBe(2); // +1 min
    expect(runCase([followUp], ['act_boost', 'act_wait', 'act_vitals']).earned).toBe(0); // +6 min
    expect(runCase([followUp], ['act_boost']).earned).toBe(0); // never
    expect(runCase([followUp], ['act_vitals']).earned).toBe(0); // target never done
  });

  it('outcome_is matches the completed outcome', () => {
    const won = entry({ kind: 'outcome_is', outcomeId: 'o_done' });
    expect(runCase([won], ['act_end']).earned).toBe(2);
    expect(runCase([won], ['act_vitals']).earned).toBe(0);
  });
});

describe('critical actions and unsafe records (spec Q/R)', () => {
  it('missedCriticalActions honors anyOf sets and deadlines', () => {
    const missed = runCase([entry({ kind: 'vitals_obtained' })], ['act_wait']);
    expect(missed.missedCriticalActions).toEqual([
      { criticalId: 'ca_vitals', label: 'Obtain vitals' },
    ]);
    const done = runCase([entry({ kind: 'vitals_obtained' })], ['act_vitals']);
    expect(done.missedCriticalActions).toEqual([]);
  });

  it('unsafeActionsTaken lists every unsafe/contraindicated log entry', () => {
    const score = runCase([entry({ kind: 'no_unsafe_actions' })], ['act_crash', 'act_boost']);
    expect(score.unsafeActionsTaken).toEqual([{ actionId: 'act_crash', classification: 'unsafe' }]);
  });
});
