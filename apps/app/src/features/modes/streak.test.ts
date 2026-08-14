import { computeStudyStreak, streakLine } from './streak';

const NY = 'America/New_York';

describe('computeStudyStreak', () => {
  const noon = (date: string) => `${date}T17:00:00Z`; // noon in New York

  it('returns zero with no attempts', () => {
    expect(computeStudyStreak([], NY, new Date(noon('2026-08-13')))).toEqual({
      currentDays: 0,
      studiedToday: false,
    });
  });

  it('counts consecutive days ending today', () => {
    const attempts = [noon('2026-08-11'), noon('2026-08-12'), noon('2026-08-13')];
    expect(computeStudyStreak(attempts, NY, new Date(noon('2026-08-13')))).toEqual({
      currentDays: 3,
      studiedToday: true,
    });
  });

  it('is non-punitive: a run ending yesterday still counts before studying today', () => {
    const attempts = [noon('2026-08-11'), noon('2026-08-12')];
    expect(computeStudyStreak(attempts, NY, new Date(noon('2026-08-13')))).toEqual({
      currentDays: 2,
      studiedToday: false,
    });
  });

  it('a gap of a full day resets the run', () => {
    const attempts = [noon('2026-08-09'), noon('2026-08-10'), noon('2026-08-13')];
    expect(computeStudyStreak(attempts, NY, new Date(noon('2026-08-13')))).toEqual({
      currentDays: 1,
      studiedToday: true,
    });
  });

  it('multiple attempts on one day count as one day', () => {
    const attempts = [noon('2026-08-13'), `2026-08-13T18:30:00Z`, `2026-08-13T21:00:00Z`];
    expect(computeStudyStreak(attempts, NY, new Date(noon('2026-08-13')))).toEqual({
      currentDays: 1,
      studiedToday: true,
    });
  });

  it('buckets by the student timezone, not UTC', () => {
    // 03:00Z on Aug 13 is still Aug 12 EVENING in New York.
    const attempts = ['2026-08-13T03:00:00Z'];
    const streak = computeStudyStreak(attempts, NY, new Date(noon('2026-08-13')));
    expect(streak).toEqual({ currentDays: 1, studiedToday: false });
    // The same instant IS Aug 13 in UTC.
    expect(computeStudyStreak(attempts, 'UTC', new Date(noon('2026-08-13')))).toEqual({
      currentDays: 1,
      studiedToday: true,
    });
  });
});

describe('streakLine', () => {
  it('is quiet when there is no streak', () => {
    expect(streakLine({ currentDays: 0, studiedToday: false })).toBeNull();
  });

  it('reports today counting when studied today', () => {
    expect(streakLine({ currentDays: 3, studiedToday: true })).toBe(
      'Study streak: 3 days — today counts.'
    );
    expect(streakLine({ currentDays: 1, studiedToday: true })).toContain('1 day —');
  });

  it('encourages without threatening when today is still open', () => {
    const line = streakLine({ currentDays: 2, studiedToday: false })!;
    expect(line).toBe('Study streak: 2 days. A little studying today keeps it going.');
    for (const banned of ['lose', 'broken', 'streak ends', 'last chance']) {
      expect(line.toLowerCase()).not.toContain(banned);
    }
  });
});
