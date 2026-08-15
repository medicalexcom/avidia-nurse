/**
 * Reminder instructions — M13 (spec AA/AD/AE/AF/AG/AJ).
 *
 * PURE planning of what should be scheduled: given preferences, the current
 * plan, and upcoming exams, produce deterministic instructions (id, UTC
 * fire time, copy, deep link). The app-side adapter turns instructions into
 * LOCAL notifications (ADR: no push infrastructure) by cancel-and-
 * reschedule, which makes scheduling idempotent (spec AN) and prevents
 * stale reminders for superseded plans (spec AY).
 *
 * Restraint rules (spec AA "do not send excessive notifications"):
 *   - at most ONE study reminder per day (a due-review day does not add a
 *     second ping — review context is merged into the study reminder);
 *   - exam reminders only at 3 days and 1 day out;
 *   - quiet hours are never violated — a reminder inside them slides to
 *     the quiet-hours end (spec AD);
 *   - bodies never expose detailed performance (spec AF).
 */

import { zonedDateTimeToUtc } from '@avidia/domain';

import { EXAM_REMINDER_DAYS, REMINDER_HORIZON_DAYS } from './config';
import { addDays, localDaysUntil } from './dates';
import { calendarDateInZone } from '@avidia/domain';
import type { PlannerExam, ReminderInstruction, ReminderPrefs, StudyPlanResult } from './types';

/** True when local `hour` falls inside quiet hours [start, end). */
export function isQuietHour(hour: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false; // zero-length window: no quiet hours
  if (quietStart < quietEnd) return hour >= quietStart && hour < quietEnd;
  return hour >= quietStart || hour < quietEnd; // wraps midnight
}

/** The hour a reminder should actually fire, respecting quiet hours. */
export function effectiveReminderHour(prefs: ReminderPrefs): number {
  if (!isQuietHour(prefs.reminderHour, prefs.quietStartHour, prefs.quietEndHour)) {
    return prefs.reminderHour;
  }
  return prefs.quietEndHour;
}

export interface ReminderBuildInput {
  prefs: ReminderPrefs;
  /** The active plan, or null when none exists. */
  plan: StudyPlanResult | null;
  exams: readonly PlannerExam[];
  timeZone: string;
  now: Date;
}

export function buildReminderInstructions(input: ReminderBuildInput): ReminderInstruction[] {
  const { prefs, plan, exams, timeZone, now } = input;
  const out: ReminderInstruction[] = [];
  const hour = effectiveReminderHour(prefs);
  const start = calendarDateInZone(now, timeZone);

  // Study-plan reminders (spec AA): one per day with planned work.
  if ((prefs.studyReminders || prefs.reviewReminders) && plan !== null) {
    for (let i = 0; i < Math.min(plan.days.length, REMINDER_HORIZON_DAYS); i += 1) {
      const day = plan.days[i]!;
      if (day.plannedMinutes <= 0) continue;
      const hasReviews = day.activities.some((a) => a.type === 'due_review');
      // Respect which reminder kinds are on: a plain study day needs
      // studyReminders; a review day fires if EITHER toggle is on.
      if (!prefs.studyReminders && !(prefs.reviewReminders && hasReviews)) continue;
      const date = addDays(start, i);
      const fireAt = zonedDateTimeToUtc({ ...date, hour, minute: 0 }, timeZone);
      if (fireAt === null || fireAt.getTime() <= now.getTime()) continue;
      out.push({
        id: `plan:${day.date}`,
        fireAt: fireAt.toISOString(),
        title: 'Avidia study plan',
        body: hasReviews
          ? `Your ${day.plannedMinutes}-minute study plan is ready — reviews are due today.`
          : `Your ${day.plannedMinutes}-minute study plan is ready.`,
        deepLink: '/planner',
      });
    }
  }

  // Exam reminders (spec AF): countdown only, no performance detail.
  if (prefs.examReminders) {
    for (const exam of exams) {
      const daysAway = localDaysUntil(exam.examAt, now, timeZone);
      if (daysAway === null || daysAway < 0) continue;
      for (const lead of EXAM_REMINDER_DAYS) {
        const offset = daysAway - lead;
        if (offset < 0) continue; // that reminder day already passed
        const date = addDays(start, offset);
        const fireAt = zonedDateTimeToUtc({ ...date, hour, minute: 0 }, timeZone);
        if (fireAt === null || fireAt.getTime() <= now.getTime()) continue;
        out.push({
          id: `exam:${exam.examId}:${lead}`,
          fireAt: fireAt.toISOString(),
          title: 'Exam coming up',
          body: `${exam.title} in ${lead === 1 ? '1 day' : `${lead} days`}.`,
          deepLink: '/planner',
        });
      }
    }
  }

  return out.sort((a, b) => a.fireAt.localeCompare(b.fireAt) || a.id.localeCompare(b.id));
}
