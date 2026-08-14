/**
 * Study consistency — M12 (spec T/U/V).
 *
 * Derived from ATTEMPT timestamps — evidence of actual answering — not from
 * session-open time (spec U: a tab left open is not studying). Calendar
 * days use the student's timezone via the domain helpers (spec AR). The
 * streak rule matches M10's non-punitive derivation: a run that extends
 * through yesterday still counts before today's first attempt. Reporting is
 * descriptive only — no minutes→mastery causal claims (spec V).
 */

import { calendarAgeDays } from './windows';
import type { AttemptRecord, SessionRecord } from './types';

export interface StudyConsistency {
  /** Distinct active calendar days in the last 7 / last 30. */
  activeDaysLast7: number;
  activeDaysLast30: number;
  attemptsLast7: number;
  attemptsLast30: number;
  completedSessionsLast30: number;
  abandonedSessionsLast30: number;
  /** Consecutive-day study streak (non-punitive, matches M10). */
  streakDays: number;
  /** Attempt counts for the last 7 calendar days, index 0 = today. */
  dailyAttemptsLast7: number[];
}

export function computeStudyConsistency(
  attempts: readonly AttemptRecord[],
  sessions: readonly SessionRecord[],
  now: Date,
  timeZone: string
): StudyConsistency {
  const activeAges = new Set<number>();
  let attemptsLast7 = 0;
  let attemptsLast30 = 0;
  const dailyAttemptsLast7 = [0, 0, 0, 0, 0, 0, 0];
  for (const attempt of attempts) {
    const age = calendarAgeDays(attempt.createdAt, now, timeZone);
    if (age < 0) continue;
    if (age < 30) {
      attemptsLast30 += 1;
      activeAges.add(Math.min(age, 29));
    }
    if (age < 7) {
      attemptsLast7 += 1;
      dailyAttemptsLast7[age] = (dailyAttemptsLast7[age] ?? 0) + 1;
    }
  }

  // Streak: walk back from today; a gap at day 0 (not studied YET today) is
  // forgiven when yesterday was active (non-punitive, M10 rule).
  const agesActive = new Set<number>();
  for (const attempt of attempts) {
    const age = calendarAgeDays(attempt.createdAt, now, timeZone);
    if (age >= 0) agesActive.add(age);
  }
  let streakDays = 0;
  let cursor = agesActive.has(0) ? 0 : agesActive.has(1) ? 1 : -1;
  while (cursor >= 0 && agesActive.has(cursor)) {
    streakDays += 1;
    cursor += 1;
  }

  let completedSessionsLast30 = 0;
  let abandonedSessionsLast30 = 0;
  for (const session of sessions) {
    const age = calendarAgeDays(session.startedAt, now, timeZone);
    if (age < 0 || age >= 30) continue;
    if (session.status === 'completed') completedSessionsLast30 += 1;
    if (session.status === 'abandoned') abandonedSessionsLast30 += 1;
  }

  const activeDaysLast7 = [...activeAges].filter((age) => age < 7).length;
  return {
    activeDaysLast7,
    activeDaysLast30: activeAges.size,
    attemptsLast7,
    attemptsLast30,
    completedSessionsLast30,
    abandonedSessionsLast30,
    streakDays,
    dailyAttemptsLast7,
  };
}
