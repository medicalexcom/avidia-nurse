/**
 * Timezone-aware date/time utilities (ADR-0007).
 *
 * Canonical storage format: UTC instants (ISO-8601 / Postgres timestamptz).
 * Display and data entry happen in the student's IANA timezone (from their
 * profile, falling back to the device timezone). Nothing here hard-codes any
 * particular timezone; all conversions go through the Intl API, which handles
 * daylight-saving transitions from the IANA database.
 */

export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

/** True when `timeZone` is a usable IANA timezone name on this runtime. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function partsInZone(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const out: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year ?? 0,
    month: out.month ?? 1,
    day: out.day ?? 1,
    // Intl reports midnight as hour 24 in some engines with hour12: false.
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** The calendar date that instant `date` falls on in `timeZone`. */
export function calendarDateInZone(date: Date, timeZone: string): CalendarDate {
  const p = partsInZone(date, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

/** Days since the epoch for a calendar date (timezone-independent). */
function dayNumber(d: CalendarDate): number {
  return Math.floor(Date.UTC(d.year, d.month - 1, d.day) / 86_400_000);
}

/**
 * Whole calendar days from `from` to `to` as experienced in `timeZone`
 * (0 = same local day, 1 = next local day, negative = past). Because this
 * compares local calendar days rather than 24-hour blocks, it is stable
 * across daylight-saving transitions.
 */
export function calendarDaysBetween(from: Date, to: Date, timeZone: string): number {
  return (
    dayNumber(calendarDateInZone(to, timeZone)) - dayNumber(calendarDateInZone(from, timeZone))
  );
}

/** The UTC offset (ms) in effect in `timeZone` at instant `ts` (ms epoch). */
function zoneOffsetMs(ts: number, timeZone: string): number {
  const p = partsInZone(new Date(ts), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - ts;
}

/**
 * Interpret a wall-clock date and time in `timeZone` and return the UTC
 * instant, or null when the input is not a real date/time. Handles
 * daylight-saving transitions (a second pass resolves offset changes; times
 * inside a spring-forward gap resolve to the instant after the gap).
 */
export function zonedDateTimeToUtc(
  date: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string
): Date | null {
  const { year, month, day, hour, minute } = date;
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    !isValidTimeZone(timeZone)
  ) {
    return null;
  }
  // Reject impossible dates like Feb 30 (Date.UTC would roll them over).
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let ts = wallAsUtc - zoneOffsetMs(wallAsUtc, timeZone);
  ts = wallAsUtc - zoneOffsetMs(ts, timeZone);
  return new Date(ts);
}

/** Parse "YYYY-MM-DD" and "HH:MM" strings; null when malformed. */
export function parseDateAndTime(
  dateText: string,
  timeText: string
): { year: number; month: number; day: number; hour: number; minute: number } | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText.trim());
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(timeText.trim());
  if (!dateMatch || !timeMatch) return null;
  return {
    year: Number(dateMatch[1]),
    month: Number(dateMatch[2]),
    day: Number(dateMatch[3]),
    hour: Number(timeMatch[1]),
    minute: Number(timeMatch[2]),
  };
}

/** A stored UTC instant rendered in the student's timezone, e.g. "Sep 4, 2026, 9:00 AM". */
export function formatInZone(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || !isValidTimeZone(timeZone)) return 'Unknown date';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/** The stored UTC instant as "YYYY-MM-DD" / "HH:MM" wall time for form editing. */
export function isoToZonedFields(
  iso: string,
  timeZone: string
): { dateText: string; timeText: string } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || !isValidTimeZone(timeZone)) return null;
  const p = partsInZone(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    dateText: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    timeText: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}
