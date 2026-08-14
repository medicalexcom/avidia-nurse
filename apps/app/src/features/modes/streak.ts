/**
 * Study streaks — M10 (spec V/W/Y/Z, ADR-0027).
 *
 * The ONLY gamification the product documents approve is streaks ("Add Boss
 * Battle, dashboards, streaks, and mastery heatmaps only after the learning
 * engine works well"). XP, levels, points, badges, and achievements appear
 * nowhere in the playbook, blueprint, or study-system document, so M10 does
 * not build them (spec V — nothing beyond what the documents support).
 *
 * A streak here is a PURE DERIVATION over the timestamps of the student's
 * own recorded answers (`question_attempts.created_at` — server-written,
 * immutable, RLS-scoped to the owner). No new state, no client-writable
 * counter, nothing to forge or repair (spec X/AL by construction): the
 * number can always be recomputed from the same server rows.
 *
 * Non-punitive by design (spec W): a streak is counted through YESTERDAY if
 * the student has not studied yet today — opening the app in the morning
 * never shows a broken streak for a day that is not over.
 */

import { calendarDateInZone } from '@avidia/domain';

export interface StudyStreak {
  /** Consecutive study days ending today (or yesterday, see above). */
  currentDays: number;
  /** Whether any answer was recorded today (in the student's timezone). */
  studiedToday: boolean;
}

const dayKey = (iso: string, timeZone: string): string => {
  const { year, month, day } = calendarDateInZone(new Date(iso), timeZone);
  return `${year}-${month}-${day}`;
};

const previousDayKey = (now: Date, timeZone: string, daysBack: number): string => {
  // Subtracting whole days in UTC then reading the zoned calendar date is
  // DST-safe for day-granularity math (the zone offset shifts by at most an
  // hour, never a day).
  const shifted = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const { year, month, day } = calendarDateInZone(shifted, timeZone);
  return `${year}-${month}-${day}`;
};

/**
 * Compute the current streak from attempt timestamps (any order, any
 * course). Timezone-correct: days are the student's calendar days.
 */
export function computeStudyStreak(
  attemptTimesIso: readonly string[],
  timeZone: string,
  now: Date
): StudyStreak {
  const studiedDays = new Set(attemptTimesIso.map((iso) => dayKey(iso, timeZone)));
  const todayKey = previousDayKey(now, timeZone, 0);
  const studiedToday = studiedDays.has(todayKey);
  // The run starts today when studied today, else yesterday (non-punitive).
  let daysBack = studiedToday ? 0 : 1;
  let currentDays = 0;
  while (studiedDays.has(previousDayKey(now, timeZone, daysBack))) {
    currentDays += 1;
    daysBack += 1;
  }
  return { currentDays, studiedToday };
}

/**
 * Student-facing streak line (spec W/AB): quiet, factual, encouraging —
 * never a threat about losing anything. Null when there is nothing to show.
 */
export function streakLine(streak: StudyStreak): string | null {
  if (streak.currentDays === 0) return null;
  const days = `${streak.currentDays} day${streak.currentDays === 1 ? '' : 's'}`;
  if (streak.studiedToday) {
    return `Study streak: ${days} — today counts.`;
  }
  return `Study streak: ${days}. A little studying today keeps it going.`;
}
