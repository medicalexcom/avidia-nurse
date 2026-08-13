import {
  calendarDateInZone,
  calendarDaysBetween,
  formatInZone,
  isValidTimeZone,
  isoToZonedFields,
  parseDateAndTime,
  zonedDateTimeToUtc,
} from './time';

const CHICAGO = 'America/Chicago';

describe('zonedDateTimeToUtc', () => {
  it('converts wall time in a named timezone to the correct UTC instant', () => {
    // Sep 4 2026, 9:00 AM Chicago (CDT, UTC-5) = 14:00 UTC.
    const result = zonedDateTimeToUtc(
      { year: 2026, month: 9, day: 4, hour: 9, minute: 0 },
      CHICAGO
    );
    expect(result?.toISOString()).toBe('2026-09-04T14:00:00.000Z');
  });

  it('uses the correct offset on either side of a DST transition', () => {
    // Mar 7 2026 9:00 AM is CST (UTC-6); Mar 9 2026 9:00 AM is CDT (UTC-5).
    expect(
      zonedDateTimeToUtc(
        { year: 2026, month: 3, day: 7, hour: 9, minute: 0 },
        CHICAGO
      )?.toISOString()
    ).toBe('2026-03-07T15:00:00.000Z');
    expect(
      zonedDateTimeToUtc(
        { year: 2026, month: 3, day: 9, hour: 9, minute: 0 },
        CHICAGO
      )?.toISOString()
    ).toBe('2026-03-09T14:00:00.000Z');
  });

  it('round-trips through isoToZonedFields', () => {
    const utc = zonedDateTimeToUtc(
      { year: 2026, month: 11, day: 2, hour: 21, minute: 30 },
      CHICAGO
    );
    const fields = isoToZonedFields(utc!.toISOString(), CHICAGO);
    expect(fields).toEqual({ dateText: '2026-11-02', timeText: '21:30' });
  });

  it('rejects impossible dates, times, and timezones', () => {
    expect(
      zonedDateTimeToUtc({ year: 2026, month: 2, day: 30, hour: 9, minute: 0 }, CHICAGO)
    ).toBeNull();
    expect(
      zonedDateTimeToUtc({ year: 2026, month: 13, day: 1, hour: 9, minute: 0 }, CHICAGO)
    ).toBeNull();
    expect(
      zonedDateTimeToUtc({ year: 2026, month: 5, day: 1, hour: 24, minute: 0 }, CHICAGO)
    ).toBeNull();
    expect(
      zonedDateTimeToUtc({ year: 2026, month: 5, day: 1, hour: 9, minute: 0 }, 'Not/AZone')
    ).toBeNull();
  });
});

describe('parseDateAndTime', () => {
  it('parses well-formed inputs', () => {
    expect(parseDateAndTime('2026-09-04', '9:00')).toEqual({
      year: 2026,
      month: 9,
      day: 4,
      hour: 9,
      minute: 0,
    });
  });

  it('rejects malformed inputs', () => {
    expect(parseDateAndTime('09/04/2026', '9:00')).toBeNull();
    expect(parseDateAndTime('2026-09-04', '9pm')).toBeNull();
    expect(parseDateAndTime('', '')).toBeNull();
  });
});

describe('calendar helpers', () => {
  it('reports the local calendar date for an instant', () => {
    // Aug 13 02:00 UTC = Aug 12 in Chicago, Aug 13 in Tokyo.
    const instant = new Date('2026-08-13T02:00:00Z');
    expect(calendarDateInZone(instant, CHICAGO)).toEqual({ year: 2026, month: 8, day: 12 });
    expect(calendarDateInZone(instant, 'Asia/Tokyo')).toEqual({ year: 2026, month: 8, day: 13 });
  });

  it('counts local calendar days between instants', () => {
    const from = new Date('2026-08-13T02:00:00Z'); // Aug 12 Chicago
    const to = new Date('2026-08-14T14:00:00Z'); // Aug 14 Chicago
    expect(calendarDaysBetween(from, to, CHICAGO)).toBe(2);
    expect(calendarDaysBetween(to, from, CHICAGO)).toBe(-2);
  });

  it('validates timezones and formats display strings', () => {
    expect(isValidTimeZone(CHICAGO)).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(formatInZone('2026-09-04T14:00:00Z', CHICAGO)).toBe('Sep 4, 2026, 9:00 AM');
    expect(formatInZone('garbage', CHICAGO)).toBe('Unknown date');
  });
});
