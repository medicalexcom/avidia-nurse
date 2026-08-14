import { computeStudyConsistency } from './consistency';
import { FIXED_NOW, TZ, attempt, daysAgo, resetFixtureIds, session } from './fixtures';

beforeEach(resetFixtureIds);

describe('study consistency (spec T/U/V)', () => {
  it('derives activity from ATTEMPTS, not session-open time (spec U)', () => {
    // One long-open abandoned session with zero attempts contributes no
    // active days; the attempts define the activity.
    const result = computeStudyConsistency(
      [attempt({ createdAt: daysAgo(0) }), attempt({ createdAt: daysAgo(2) })],
      [session({ status: 'abandoned', startedAt: daysAgo(1), completedAt: null, attemptCount: 0 })],
      FIXED_NOW,
      TZ
    );
    expect(result.activeDaysLast7).toBe(2);
    expect(result.attemptsLast7).toBe(2);
    expect(result.abandonedSessionsLast30).toBe(1);
  });

  it('streak counts a run through yesterday before studying today (non-punitive)', () => {
    const result = computeStudyConsistency(
      [attempt({ createdAt: daysAgo(1) }), attempt({ createdAt: daysAgo(2) })],
      [],
      FIXED_NOW,
      TZ
    );
    expect(result.streakDays).toBe(2);
  });

  it('streak includes today and stops at a gap', () => {
    const result = computeStudyConsistency(
      [
        attempt({ createdAt: daysAgo(0) }),
        attempt({ createdAt: daysAgo(1) }),
        attempt({ createdAt: daysAgo(3) }), // gap at day 2
      ],
      [],
      FIXED_NOW,
      TZ
    );
    expect(result.streakDays).toBe(2);
  });

  it('zero attempts → zero everything, no errors', () => {
    const result = computeStudyConsistency([], [], FIXED_NOW, TZ);
    expect(result.streakDays).toBe(0);
    expect(result.activeDaysLast30).toBe(0);
    expect(result.dailyAttemptsLast7).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('daily histogram indexes by calendar age (0 = today)', () => {
    const result = computeStudyConsistency(
      [
        attempt({ createdAt: daysAgo(0) }),
        attempt({ createdAt: daysAgo(0, 1) }),
        attempt({ createdAt: daysAgo(4) }),
      ],
      [],
      FIXED_NOW,
      TZ
    );
    expect(result.dailyAttemptsLast7[0]).toBe(2);
    expect(result.dailyAttemptsLast7[4]).toBe(1);
  });
});
