/**
 * Availability + local-date tests — M13 (spec B/C/AJ).
 */

import {
  availabilityFromPreset,
  clampMinutes,
  hasNoAvailability,
  minutesForWeekday,
  normalizeWeek,
  uniformWeek,
} from './availability';
import { addDays, localDateKey, localDaysUntil, weekdayOf } from './dates';
import { TZ } from './fixtures';

describe('availability (spec B/C)', () => {
  it('builds presets as uniform weeks', () => {
    expect(availabilityFromPreset('light').minutesByWeekday).toEqual([20, 20, 20, 20, 20, 20, 20]);
    expect(availabilityFromPreset('standard').minutesByWeekday[0]).toBe(45);
    expect(availabilityFromPreset('intensive').minutesByWeekday[0]).toBe(90);
    expect(availabilityFromPreset('custom').preset).toBe('custom');
  });

  it('clamps stored values into sane bounds', () => {
    expect(clampMinutes(-5)).toBe(0);
    expect(clampMinutes(9999)).toBe(240);
    expect(clampMinutes(Number.NaN)).toBe(0);
    expect(normalizeWeek([30, 60])).toEqual([30, 60, 0, 0, 0, 0, 0]);
  });

  it('looks up per-weekday minutes and detects the empty config', () => {
    const config = {
      preset: 'custom' as const,
      minutesByWeekday: normalizeWeek([0, 30, 60, 20, 45, 30, 0]),
    };
    expect(minutesForWeekday(config, 1)).toBe(30);
    expect(minutesForWeekday(config, 8)).toBe(30); // wraps
    expect(hasNoAvailability(config)).toBe(false);
    expect(hasNoAvailability({ preset: 'custom', minutesByWeekday: uniformWeek(0) })).toBe(true);
  });
});

describe('local dates (spec AJ)', () => {
  it('derives local day keys and weekdays in the student timezone', () => {
    const lateUtc = new Date('2026-08-15T03:00:00Z'); // still Friday in NY
    expect(localDateKey(lateUtc, TZ)).toBe('2026-08-14');
    expect(localDateKey(lateUtc, 'UTC')).toBe('2026-08-15');
    expect(weekdayOf({ year: 2026, month: 8, day: 14 })).toBe(5); // Friday
  });

  it('adds days across month and DST boundaries', () => {
    expect(addDays({ year: 2026, month: 8, day: 30 }, 3)).toEqual({ year: 2026, month: 9, day: 2 });
    // Crossing the US fall-back transition stays a plain calendar step.
    expect(addDays({ year: 2026, month: 10, day: 31 }, 2)).toEqual({
      year: 2026,
      month: 11,
      day: 2,
    });
  });

  it('counts local days until an instant (today/tomorrow/past)', () => {
    const now = new Date('2026-08-14T15:00:00Z');
    expect(localDaysUntil('2026-08-14T23:00:00Z', now, TZ)).toBe(0);
    expect(localDaysUntil('2026-08-15T13:00:00Z', now, TZ)).toBe(1);
    expect(localDaysUntil('2026-08-12T13:00:00Z', now, TZ)).toBe(-2);
    expect(localDaysUntil('nonsense', now, TZ)).toBeNull();
    // Midnight edge: 03:00 UTC on the 15th is still the 14th in NY → 0 days.
    expect(localDaysUntil('2026-08-15T03:00:00Z', now, TZ)).toBe(0);
  });
});
