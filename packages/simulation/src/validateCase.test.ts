/**
 * Case validation gate tests (spec AB): every built-in case passes, and
 * representative authoring mistakes are rejected with specific errors.
 */

import { BUILTIN_CASES, postopPeCase } from './cases';
import { makeTestCase } from './testCase.fixture';
import type { SimulationCaseDefinition } from './types';
import { validateCase } from './validateCase';

function mutate(fn: (c: SimulationCaseDefinition) => void): SimulationCaseDefinition {
  const copy = JSON.parse(JSON.stringify(postopPeCase)) as SimulationCaseDefinition;
  fn(copy);
  return copy;
}

describe('built-in library (spec AB/AF)', () => {
  it.each(BUILTIN_CASES.map((c) => [c.caseId, c] as const))(
    '%s passes the validation gate',
    (_id, caseDef) => {
      expect(validateCase(caseDef)).toEqual({ valid: true, errors: [] });
    }
  );

  it('the engine test fixture is also a valid case', () => {
    expect(validateCase(makeTestCase()).valid).toBe(true);
  });

  it('case ids are unique across the library', () => {
    const ids = BUILTIN_CASES.map((c) => c.caseId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('rejections (spec AB)', () => {
  it('rejects an engine version mismatch (spec AY)', () => {
    const bad = mutate((c) => {
      c.engineVersion = 99;
    });
    expect(validateCase(bad).valid).toBe(false);
  });

  it('rejects rules that reference unknown actions, findings, or vitals', () => {
    const bad = mutate((c) => {
      c.rules[0]!.trigger = { kind: 'action', actionId: 'a_missing' };
      c.rules[1]!.effects.push({ kind: 'reveal_finding', findingId: 'f_missing' });
    });
    const result = validateCase(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('a_missing'))).toBe(true);
    expect(result.errors.some((e) => e.includes('f_missing'))).toBe(true);
  });

  it('rejects an end effect naming an unknown outcome', () => {
    const bad = mutate((c) => {
      c.rules.find((r) => r.id === 'r_timeout')!.effects = [
        { kind: 'end', outcomeId: 'o_missing' },
      ];
    });
    expect(validateCase(bad).valid).toBe(false);
  });

  it('rejects a case with no guaranteed termination (spec BB)', () => {
    const bad = mutate((c) => {
      c.rules = c.rules.filter((r) => {
        const endsByTime = r.trigger.kind === 'time' && r.effects.some((e) => e.kind === 'end');
        return !endsByTime;
      });
      c.outcomes = c.outcomes.filter((o) => o.id === 'o_stabilized' || o.id === 'o_complication');
      c.scoring = c.scoring.filter((s) => s.criterion.kind !== 'outcome_is');
    });
    const result = validateCase(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('run forever'))).toBe(true);
  });

  it('rejects outcomes no rule can ever produce', () => {
    const bad = mutate((c) => {
      c.outcomes.push({
        id: 'o_orphan',
        kind: 'timeout',
        label: 'Orphan',
        summary: 'Unreachable.',
      });
    });
    const result = validateCase(bad);
    expect(result.errors.some((e) => e.includes('o_orphan'))).toBe(true);
  });

  it('rejects dishonest concept keys (spec T/AD)', () => {
    const bad = mutate((c) => {
      c.conceptMappings[0]!.conceptKey = 'wrong key';
    });
    expect(validateCase(bad).errors.some((e) => e.includes('conceptKey does not match'))).toBe(
      true
    );
  });

  it('rejects concept mappings onto dimensions with no scoring entries', () => {
    const bad = mutate((c) => {
      c.scoring = c.scoring.filter((s) => s.dimension !== 'analyze_cues');
    });
    expect(validateCase(bad).errors.some((e) => e.includes('has no scoring entries'))).toBe(true);
  });

  it('rejects criticalActions with unknown or empty action lists', () => {
    const bad = mutate((c) => {
      c.criticalActions[0]!.anyOfActionIds = [];
      c.criticalActions[1]!.anyOfActionIds = ['a_missing'];
    });
    const result = validateCase(bad);
    expect(result.errors.some((e) => e.includes('must not be empty'))).toBe(true);
    expect(result.errors.some((e) => e.includes('a_missing'))).toBe(true);
  });

  it('rejects duplicated ids within a collection', () => {
    const bad = mutate((c) => {
      c.actions.push({ ...c.actions[0]! });
    });
    expect(validateCase(bad).valid).toBe(false);
  });

  it('rejects promptRequired on non-dialogue actions', () => {
    const bad = mutate((c) => {
      c.actions.find((a) => a.id === 'a_wait')!.promptRequired = true;
    });
    expect(validateCase(bad).valid).toBe(false);
  });
});
