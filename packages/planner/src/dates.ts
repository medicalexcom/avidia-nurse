/**
 * Local-calendar helpers — M13 (spec AJ timezone correctness).
 *
 * Canonical timestamps stay UTC; plan DAYS are local calendar dates in the
 * student's timezone, derived through @avidia/domain's DST-safe helpers.
 */

import { calendarDateInZone, calendarDaysBetween, type CalendarDate } from '@avidia/domain';

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" for a calendar date. */
export function dateKey(d: CalendarDate): string {
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

/** The local date key of instant `date` in `timeZone`. */
export function localDateKey(date: Date, timeZone: string): string {
  return dateKey(calendarDateInZone(date, timeZone));
}

/** JavaScript weekday (Sunday=0) for a calendar date — tz-independent math. */
export function weekdayOf(d: CalendarDate): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

/** Add whole days to a calendar date. */
export function addDays(d: CalendarDate, days: number): CalendarDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/**
 * Local days from `now` until the instant `iso`, in `timeZone`
 * (0 today, 1 tomorrow, negative past). NaN-safe: null for invalid input.
 */
export function localDaysUntil(iso: string, now: Date, timeZone: string): number | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return calendarDaysBetween(now, at, timeZone);
}
