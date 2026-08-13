import { calendarDaysBetween, isValidTimeZone } from './time';

/**
 * Reusable exam countdown (Playbook §7 "Next exam countdown").
 *
 * Countdown is expressed in LOCAL calendar days in the student's timezone:
 * an exam at 8am tomorrow is "Exam tomorrow" whether that is 10 or 30 hours
 * away, and daylight-saving transitions cannot skew the day count because we
 * compare calendar dates, not 24-hour intervals. An exam earlier today stays
 * "Exam today" until the local day ends, then becomes "Exam completed".
 */

export type CountdownKind = 'invalid' | 'completed' | 'today' | 'tomorrow' | 'upcoming';

export interface ExamCountdown {
  kind: CountdownKind;
  /** Whole local calendar days until the exam (0 today, negative past). */
  days: number | null;
  /** User-facing label, e.g. "Exam in 6 days". */
  label: string;
}

export function examCountdown(
  examAtIso: string | null | undefined,
  timeZone: string,
  now: Date = new Date()
): ExamCountdown {
  if (!examAtIso || !isValidTimeZone(timeZone)) {
    return { kind: 'invalid', days: null, label: 'Date unavailable' };
  }
  const examAt = new Date(examAtIso);
  if (Number.isNaN(examAt.getTime())) {
    return { kind: 'invalid', days: null, label: 'Date unavailable' };
  }
  const days = calendarDaysBetween(now, examAt, timeZone);
  if (days < 0) return { kind: 'completed', days, label: 'Exam completed' };
  if (days === 0) return { kind: 'today', days, label: 'Exam today' };
  if (days === 1) return { kind: 'tomorrow', days, label: 'Exam tomorrow' };
  return { kind: 'upcoming', days, label: `Exam in ${days} days` };
}

/** The next non-completed exam from a list, by soonest exam_at; null if none. */
export function nextUpcomingExam<T extends { exam_at: string }>(
  exams: readonly T[],
  timeZone: string,
  now: Date = new Date()
): T | null {
  let best: T | null = null;
  for (const exam of exams) {
    const countdown = examCountdown(exam.exam_at, timeZone, now);
    if (countdown.kind === 'completed' || countdown.kind === 'invalid') continue;
    if (!best || new Date(exam.exam_at).getTime() < new Date(best.exam_at).getTime()) {
      best = exam;
    }
  }
  return best;
}
