/**
 * Data-integrity tests — M12 (spec AU): malformed, partial, and boundary
 * inputs must degrade to honest "no data" outputs, never NaN, Infinity,
 * negative counts, or thrown errors.
 */

import { getCourseAnalytics } from './overview';
import {
  attempt,
  concept,
  daysAgo,
  input,
  masteryRecord,
  resetFixtureIds,
  simulation,
} from './fixtures';

beforeEach(resetFixtureIds);

function assertNoBadNumbers(value: unknown, path = 'root'): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value)).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoBadNumbers(v, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoBadNumbers(v, `${path}.${k}`);
  }
}

describe('data integrity (spec AU)', () => {
  it('attempts referencing unknown concepts do not crash or leak rows', () => {
    const result = getCourseAnalytics(
      input({
        concepts: [concept({ conceptId: 'c-1' })],
        attempts: [attempt({ conceptId: 'ghost-concept' }), attempt({ conceptId: null })],
      })
    );
    expect(result.conceptAnalytics.concepts).toHaveLength(1);
    assertNoBadNumbers(result);
  });

  it('mastery rows without a matching concept are ignored, not invented', () => {
    const result = getCourseAnalytics(
      input({
        concepts: [concept({ conceptId: 'c-1' })],
        mastery: [masteryRecord('ghost', { mastery: 0.1, attemptsCount: 9 })],
      })
    );
    expect(result.distribution.totalConcepts).toBe(1);
    expect(result.distribution.distribution.needs_review).toBe(0);
  });

  it('future-dated attempts never count toward windows or streaks', () => {
    const result = getCourseAnalytics(
      input({
        concepts: [concept({ conceptId: 'c-1' })],
        attempts: [attempt({ conceptId: 'c-1', createdAt: daysAgo(-3) })],
      })
    );
    expect(result.consistency.attemptsLast30).toBe(0);
    expect(result.consistency.streakDays).toBe(0);
    expect(result.weekOverWeek.recentCount).toBe(0);
  });

  it('simulations with zero possible points produce no division blowups', () => {
    const result = getCourseAnalytics(
      input({
        simulations: [
          simulation({ earned: 0, possible: 0, dimensions: [] }),
          simulation({ earned: 0, possible: 0, dimensions: [] }),
          simulation({ earned: 0, possible: 0, dimensions: [] }),
        ],
      })
    );
    expect(result.simulation.scoreTrend).toBe('insufficient');
    assertNoBadNumbers(result);
  });

  it('completely empty input yields a fully-formed, finite result', () => {
    const result = getCourseAnalytics(input());
    expect(result.isEmpty).toBe(true);
    assertNoBadNumbers(result);
    expect(result.cognitiveLevels.every((r) => r.accuracy === null)).toBe(true);
    expect(result.difficulties.every((r) => r.accuracy === null)).toBe(true);
  });

  it('duplicate attempt ids are tolerated (counts stay integral)', () => {
    const same = attempt({ conceptId: 'c-1', attemptId: 'dup' });
    const result = getCourseAnalytics(
      input({ concepts: [concept({ conceptId: 'c-1' })], attempts: [same, { ...same }] })
    );
    expect(result.consistency.attemptsLast30).toBe(2);
    assertNoBadNumbers(result);
  });
});
