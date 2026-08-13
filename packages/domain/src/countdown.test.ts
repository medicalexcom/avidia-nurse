import { examCountdown, nextUpcomingExam } from './countdown';

const CHICAGO = 'America/Chicago';
const TOKYO = 'Asia/Tokyo';

describe('examCountdown', () => {
  // Reference "now": Aug 12 2026, 9:00 PM Chicago (CDT, UTC-5) = Aug 13 02:00 UTC.
  const now = new Date('2026-08-13T02:00:00Z');

  it('labels an exam later the same local day as today', () => {
    // Aug 12 11:00 PM Chicago = Aug 13 04:00 UTC.
    const result = examCountdown('2026-08-13T04:00:00Z', CHICAGO, now);
    expect(result).toEqual({ kind: 'today', days: 0, label: 'Exam today' });
  });

  it('labels an exam earlier the same local day as today (not completed)', () => {
    // Aug 12 8:00 AM Chicago = Aug 12 13:00 UTC — already past, same local day.
    const result = examCountdown('2026-08-12T13:00:00Z', CHICAGO, now);
    expect(result.kind).toBe('today');
  });

  it('labels tomorrow and future days', () => {
    // Aug 13 9:00 AM Chicago = Aug 13 14:00 UTC (only 12 hours away, but next local day).
    expect(examCountdown('2026-08-13T14:00:00Z', CHICAGO, now).label).toBe('Exam tomorrow');
    // Aug 18 Chicago — six local days after Aug 12.
    expect(examCountdown('2026-08-18T14:00:00Z', CHICAGO, now).label).toBe('Exam in 6 days');
  });

  it('labels past exams as completed', () => {
    const result = examCountdown('2026-08-10T14:00:00Z', CHICAGO, now);
    expect(result.kind).toBe('completed');
    expect(result.label).toBe('Exam completed');
  });

  it('depends on the user timezone at day boundaries', () => {
    // Same instant: Aug 13 02:00 UTC is Aug 12 in Chicago but Aug 13 in Tokyo.
    const examAt = '2026-08-14T02:00:00Z'; // Aug 13 9pm Chicago; Aug 14 11am Tokyo.
    expect(examCountdown(examAt, CHICAGO, now).label).toBe('Exam tomorrow');
    expect(examCountdown(examAt, TOKYO, now).label).toBe('Exam tomorrow');
    // Now in Tokyo is already Aug 13, so an Aug 13 UTC-evening exam differs:
    const lateExam = '2026-08-13T16:00:00Z'; // Aug 13 11am Chicago; Aug 14 1am Tokyo.
    expect(examCountdown(lateExam, CHICAGO, now).label).toBe('Exam tomorrow');
    expect(examCountdown(lateExam, TOKYO, now).label).toBe('Exam tomorrow');
    const earlyExam = '2026-08-13T14:00:00Z'; // Aug 13 9am Chicago; Aug 13 11pm Tokyo.
    expect(examCountdown(earlyExam, TOKYO, now).label).toBe('Exam today');
  });

  it('is stable across the US spring-forward DST transition', () => {
    // Now: Mar 7 2026, 10:00 PM Chicago (CST, UTC-6) = Mar 8 04:00 UTC.
    // DST starts Mar 8 2026 at 2:00 AM Chicago — that night is only 23 hours.
    const beforeDst = new Date('2026-03-08T04:00:00Z');
    // Exam: Mar 9 2026, 9:00 AM Chicago (now CDT, UTC-5) = Mar 9 14:00 UTC.
    // Elapsed time is under 48h because of the lost hour; still "in 2 days".
    const result = examCountdown('2026-03-09T14:00:00Z', CHICAGO, beforeDst);
    expect(result).toEqual({ kind: 'upcoming', days: 2, label: 'Exam in 2 days' });
  });

  it('is stable across the US fall-back DST transition', () => {
    // Now: Oct 31 2026, 10:00 PM Chicago (CDT, UTC-5) = Nov 1 03:00 UTC.
    // DST ends Nov 1 2026 — that night is 25 hours long.
    const beforeFallBack = new Date('2026-11-01T03:00:00Z');
    // Exam: Nov 2 2026, 9:00 AM Chicago (CST, UTC-6) = Nov 2 15:00 UTC.
    const result = examCountdown('2026-11-02T15:00:00Z', CHICAGO, beforeFallBack);
    expect(result).toEqual({ kind: 'upcoming', days: 2, label: 'Exam in 2 days' });
  });

  it('handles missing and invalid dates without crashing', () => {
    expect(examCountdown(null, CHICAGO, now).kind).toBe('invalid');
    expect(examCountdown(undefined, CHICAGO, now).kind).toBe('invalid');
    expect(examCountdown('not-a-date', CHICAGO, now).kind).toBe('invalid');
    expect(examCountdown('2026-08-14T02:00:00Z', 'Not/AZone', now).kind).toBe('invalid');
  });
});

describe('nextUpcomingExam', () => {
  const now = new Date('2026-08-13T02:00:00Z'); // Aug 12 evening in Chicago.

  it('returns the soonest non-completed exam', () => {
    const exams = [
      { id: 'past', exam_at: '2026-08-01T14:00:00Z' },
      { id: 'later', exam_at: '2026-09-20T14:00:00Z' },
      { id: 'soon', exam_at: '2026-08-20T14:00:00Z' },
    ];
    expect(nextUpcomingExam(exams, CHICAGO, now)?.id).toBe('soon');
  });

  it('returns null when every exam is completed or invalid', () => {
    const exams = [
      { id: 'past', exam_at: '2026-08-01T14:00:00Z' },
      { id: 'broken', exam_at: 'nope' },
    ];
    expect(nextUpcomingExam(exams, CHICAGO, now)).toBeNull();
    expect(nextUpcomingExam([], CHICAGO, now)).toBeNull();
  });
});
