/**
 * Reconciliation tests — M13 (spec U/Z/AN idempotency).
 */

import {
  matchSessionsToActivities,
  sessionSatisfies,
  type CompletedSessionLike,
  type MatchableActivity,
} from './match';

const activity = (
  id: string,
  type: MatchableActivity['type'],
  overrides: Partial<MatchableActivity> = {}
): MatchableActivity => ({
  activityId: id,
  courseId: 'c1',
  type,
  boundSessionId: null,
  ...overrides,
});

const session = (
  id: string,
  sessionType: string,
  completedAt: string,
  courseId = 'c1'
): CompletedSessionLike => ({ sessionId: id, courseId, sessionType, completedAt });

describe('sessionSatisfies (spec M/U)', () => {
  it('maps adaptive/practice sessions to the generic activity types', () => {
    for (const type of ['start_today', 'due_review', 'targeted_practice'] as const) {
      expect(sessionSatisfies(type, 'adaptive')).toBe(true);
      expect(sessionSatisfies(type, 'practice')).toBe(true);
      expect(sessionSatisfies(type, 'rapid_response')).toBe(false);
    }
  });

  it('maps each mode and simulation to its own type only', () => {
    expect(sessionSatisfies('priority_challenge', 'who_first')).toBe(true);
    expect(sessionSatisfies('priority_challenge', 'adaptive')).toBe(false);
    expect(sessionSatisfies('medication_lab', 'medication_lab')).toBe(true);
    expect(sessionSatisfies('boss_battle', 'boss_battle')).toBe(true);
    expect(sessionSatisfies('find_the_danger', 'find_the_danger')).toBe(true);
    expect(sessionSatisfies('rapid_response', 'rapid_response')).toBe(true);
    expect(sessionSatisfies('simulation', 'simulation')).toBe(true);
    expect(sessionSatisfies('simulation', 'adaptive')).toBe(false);
  });
});

describe('matchSessionsToActivities', () => {
  it('one completed session satisfies exactly one activity (spec AN)', () => {
    const assignments = matchSessionsToActivities(
      [activity('a1', 'due_review'), activity('a2', 'targeted_practice')],
      [session('s1', 'adaptive', '2026-08-14T16:00:00Z')]
    );
    expect(assignments).toEqual([{ activityId: 'a1', sessionId: 's1' }]);
  });

  it('consumes sessions in completion order against plan order', () => {
    const assignments = matchSessionsToActivities(
      [
        activity('a1', 'due_review'),
        activity('a2', 'priority_challenge'),
        activity('a3', 'targeted_practice'),
      ],
      [
        session('s2', 'adaptive', '2026-08-14T17:00:00Z'),
        session('s1', 'who_first', '2026-08-14T16:00:00Z'),
      ]
    );
    expect(assignments).toEqual([
      { activityId: 'a2', sessionId: 's1' },
      { activityId: 'a1', sessionId: 's2' },
    ]);
  });

  it('is idempotent: bound activities and sessions are never rematched', () => {
    const assignments = matchSessionsToActivities(
      [activity('a1', 'due_review', { boundSessionId: 's1' }), activity('a2', 'targeted_practice')],
      [session('s1', 'adaptive', '2026-08-14T16:00:00Z')]
    );
    expect(assignments).toEqual([]);
  });

  it('never matches across courses (spec G isolation)', () => {
    const assignments = matchSessionsToActivities(
      [activity('a1', 'targeted_practice', { courseId: 'course-a' })],
      [session('s1', 'adaptive', '2026-08-14T16:00:00Z', 'course-b')]
    );
    expect(assignments).toEqual([]);
  });

  it('leaves unmatched sessions and activities alone (spec Z partial work)', () => {
    const assignments = matchSessionsToActivities(
      [activity('a1', 'simulation')],
      [session('s1', 'adaptive', '2026-08-14T16:00:00Z')]
    );
    expect(assignments).toEqual([]);
  });
});
