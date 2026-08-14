import { EXAM_URGENCY_BEYOND } from './config';
import { examRelevanceFactor, examUrgency, type UpcomingExam } from './examUrgency';

const CHICAGO = 'America/Chicago';
// 2026-08-13 07:00 in Chicago (CDT, UTC-5).
const NOW = new Date('2026-08-13T12:00:00.000Z');

function exam(examAt: string, overrides: Partial<UpcomingExam> = {}): UpcomingExam {
  return { examId: 'exam-1', examAt, ...overrides };
}

describe('examUrgency (spec L/AI)', () => {
  it('steps by calendar days in the student timezone', () => {
    expect(examUrgency(exam('2026-08-13T23:00:00.000Z'), NOW, CHICAGO)).toBe(1.0); // today
    expect(examUrgency(exam('2026-08-14T14:00:00.000Z'), NOW, CHICAGO)).toBe(0.95); // tomorrow
    expect(examUrgency(exam('2026-08-16T14:00:00.000Z'), NOW, CHICAGO)).toBe(0.8); // 3 days
    expect(examUrgency(exam('2026-08-20T14:00:00.000Z'), NOW, CHICAGO)).toBe(0.55); // 7 days
    expect(examUrgency(exam('2026-08-27T14:00:00.000Z'), NOW, CHICAGO)).toBe(0.3); // 14 days
    expect(examUrgency(exam('2026-10-01T14:00:00.000Z'), NOW, CHICAGO)).toBe(EXAM_URGENCY_BEYOND);
  });

  it('past exams contribute nothing (spec L)', () => {
    expect(examUrgency(exam('2026-08-12T14:00:00.000Z'), NOW, CHICAGO)).toBeNull();
  });

  it('rejects invalid exam timestamps safely', () => {
    expect(examUrgency(exam('not-a-date'), NOW, CHICAGO)).toBeNull();
  });

  it('midnight boundary: an exam at 00:30 local is "tomorrow" in the student zone, not UTC (spec AI)', () => {
    // 2026-08-14 00:30 Chicago = 2026-08-14T05:30Z. In UTC both instants are
    // the 14th, but the test asserts the CHICAGO calendar difference of 1.
    expect(examUrgency(exam('2026-08-14T05:30:00.000Z'), NOW, CHICAGO)).toBe(0.95);
    // Same instant viewed from Tokyo (UTC+9) is already the 14th while "now"
    // is the 13th 21:00 — still 1 calendar day. A zone west of Chicago
    // (Honolulu, UTC-10): now = 13th 02:00, exam = 13th 19:30 → same day.
    expect(examUrgency(exam('2026-08-14T05:30:00.000Z'), NOW, 'Pacific/Honolulu')).toBe(1.0);
  });

  it('DST transition does not distort the day count (spec AI)', () => {
    // Across the US fall-back (2026-11-01): Oct 30 → Nov 2 is 3 calendar
    // days in Chicago even though the elapsed hours are 73.
    const before = new Date('2026-10-30T17:00:00.000Z'); // Oct 30 12:00 CDT
    expect(examUrgency(exam('2026-11-02T18:00:00.000Z'), before, CHICAGO)).toBe(0.8);
  });
});

describe('examRelevanceFactor (spec L/M/O)', () => {
  it('is neutral (1.0) with no upcoming exams', () => {
    expect(examRelevanceFactor('c1', [], NOW, CHICAGO)).toEqual({
      factor: 1,
      urgentExamId: null,
    });
  });

  it('scales by the most urgent in-scope exam', () => {
    const exams = [
      exam('2026-08-27T14:00:00.000Z', { examId: 'far' }),
      exam('2026-08-14T14:00:00.000Z', { examId: 'near' }),
    ];
    const { factor, urgentExamId } = examRelevanceFactor('c1', exams, NOW, CHICAGO);
    expect(urgentExamId).toBe('near');
    expect(factor).toBeCloseTo(1 + 1.5 * 0.95, 6);
  });

  it('respects an explicit concept scope (spec M manual-adjustment path)', () => {
    const scoped = exam('2026-08-14T14:00:00.000Z', { conceptIds: ['c2'] });
    expect(examRelevanceFactor('c1', [scoped], NOW, CHICAGO).urgentExamId).toBeNull();
    expect(examRelevanceFactor('c2', [scoped], NOW, CHICAGO).urgentExamId).toBe('exam-1');
  });

  it('applies course-wide when no scope is given (spec M default)', () => {
    const unscoped = exam('2026-08-14T14:00:00.000Z');
    expect(examRelevanceFactor('any-concept', [unscoped], NOW, CHICAGO).urgentExamId).toBe(
      'exam-1'
    );
  });
});
