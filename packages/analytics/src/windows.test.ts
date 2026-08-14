import { calendarAgeDays, inWindow, recordsInWindow, splitWeekOverWeek } from './windows';

const TZ = 'America/New_York';

describe('time windows (spec C/AR)', () => {
  it('computes calendar-day age in the student timezone, not UTC', () => {
    // 2026-08-15T02:00Z is Aug 14 22:00 in New York — same calendar day as
    // now (Aug 14 late evening NY), even though UTC has rolled to Aug 15.
    const now = new Date('2026-08-15T03:00:00Z'); // Aug 14, 23:00 NY
    expect(calendarAgeDays('2026-08-15T02:00:00Z', now, TZ)).toBe(0);
    expect(calendarAgeDays('2026-08-14T02:00:00Z', now, TZ)).toBe(1); // Aug 13 NY
  });

  it('handles the spring-forward DST transition (spec AR)', () => {
    // US DST began 2026-03-08 in America/New_York (23-hour day).
    const now = new Date('2026-03-09T16:00:00Z'); // Mar 9, 12:00 EDT
    expect(calendarAgeDays('2026-03-08T15:00:00Z', now, TZ)).toBe(1);
    expect(calendarAgeDays('2026-03-07T15:00:00Z', now, TZ)).toBe(2);
  });

  it('handles the fall-back DST transition (25-hour day)', () => {
    // US DST ended 2026-11-01 in America/New_York.
    const now = new Date('2026-11-02T17:00:00Z'); // Nov 2, 12:00 EST
    expect(calendarAgeDays('2026-11-01T15:00:00Z', now, TZ)).toBe(1);
    expect(calendarAgeDays('2026-10-31T15:00:00Z', now, TZ)).toBe(2);
  });

  it('window membership excludes the future', () => {
    expect(inWindow(-1, 'courseToDate')).toBe(false);
    expect(inWindow(0, 'today')).toBe(true);
    expect(inWindow(1, 'today')).toBe(false);
    expect(inWindow(6, 'last7')).toBe(true);
    expect(inWindow(7, 'last7')).toBe(false);
    expect(inWindow(29, 'last30')).toBe(true);
    expect(inWindow(30, 'last30')).toBe(false);
    expect(inWindow(999, 'courseToDate')).toBe(true);
  });

  it('filters records into a window', () => {
    const now = new Date('2026-08-14T15:00:00Z');
    const records = [
      { createdAt: '2026-08-14T12:00:00Z' },
      { createdAt: '2026-08-01T12:00:00Z' },
      { createdAt: '2026-09-01T12:00:00Z' }, // future — excluded
    ];
    expect(recordsInWindow(records, 'last7', now, TZ)).toHaveLength(1);
    expect(recordsInWindow(records, 'last30', now, TZ)).toHaveLength(2);
  });

  it('splits week-over-week into days 0-6 and 7-13 only', () => {
    const now = new Date('2026-08-14T15:00:00Z');
    const mk = (iso: string) => ({ createdAt: iso });
    const { thisWeek, previousWeek } = splitWeekOverWeek(
      [
        mk('2026-08-14T12:00:00Z'), // day 0
        mk('2026-08-08T12:00:00Z'), // day 6
        mk('2026-08-07T12:00:00Z'), // day 7
        mk('2026-08-01T12:00:00Z'), // day 13
        mk('2026-07-31T12:00:00Z'), // day 14 — outside both
        mk('2026-08-20T12:00:00Z'), // future — outside both
      ],
      now,
      TZ
    );
    expect(thisWeek).toHaveLength(2);
    expect(previousWeek).toHaveLength(2);
  });
});
