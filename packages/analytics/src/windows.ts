/**
 * Time-window helpers — M12 (spec C/AR).
 *
 * All storage is UTC; all "day" boundaries are CALENDAR days in the
 * student's timezone, computed with the same domain helpers the rest of the
 * app uses (`calendarDateInZone` / `calendarDaysBetween`) so analytics and
 * countdown UIs can never disagree, including across DST transitions.
 */

import { calendarDaysBetween } from '@avidia/domain';

export type WindowKey = 'today' | 'last7' | 'last30' | 'courseToDate';

export interface DatedRecord {
  createdAt: string;
}

/**
 * Memo for calendar-age lookups: the underlying `calendarDaysBetween` goes
 * through Intl timezone formatting, which is far too slow to call once per
 * attempt per module over thousands of attempts (spec AV). Memoizing a pure
 * function changes nothing about determinism. Bounded so long sessions
 * cannot grow it without limit.
 */
const ageCache = new Map<string, number>();
const AGE_CACHE_MAX = 50_000;

/**
 * Calendar-day age of a UTC instant relative to `now`, in the student's
 * timezone: 0 = today, 1 = yesterday, negative = future.
 */
export function calendarAgeDays(iso: string, now: Date, timeZone: string): number {
  const key = `${now.getTime()}|${timeZone}|${iso}`;
  const cached = ageCache.get(key);
  if (cached !== undefined) return cached;
  const age = calendarDaysBetween(new Date(Date.parse(iso)), now, timeZone);
  if (ageCache.size >= AGE_CACHE_MAX) ageCache.clear();
  ageCache.set(key, age);
  return age;
}

/** Whether an instant falls inside a window ending today (inclusive). */
export function inWindow(ageDays: number, window: WindowKey): boolean {
  if (ageDays < 0) return false;
  switch (window) {
    case 'today':
      return ageDays === 0;
    case 'last7':
      return ageDays < 7;
    case 'last30':
      return ageDays < 30;
    case 'courseToDate':
      return true;
  }
}

/** Filter dated records to a window (spec C). */
export function recordsInWindow<T extends DatedRecord>(
  records: readonly T[],
  window: WindowKey,
  now: Date,
  timeZone: string
): T[] {
  return records.filter((r) => inWindow(calendarAgeDays(r.createdAt, now, timeZone), window));
}

/**
 * Split records into "this week" (calendar days 0–6) and "previous week"
 * (days 7–13) for the week-over-week comparison (spec C). Days ≥ 14 and
 * future records fall outside both.
 */
export function splitWeekOverWeek<T extends DatedRecord>(
  records: readonly T[],
  now: Date,
  timeZone: string
): { thisWeek: T[]; previousWeek: T[] } {
  const thisWeek: T[] = [];
  const previousWeek: T[] = [];
  for (const record of records) {
    const age = calendarAgeDays(record.createdAt, now, timeZone);
    if (age >= 0 && age < 7) thisWeek.push(record);
    else if (age >= 7 && age < 14) previousWeek.push(record);
  }
  return { thisWeek, previousWeek };
}
