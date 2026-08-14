/**
 * Exam-proximity urgency — M8 (spec L/M/AI).
 *
 * Urgency is a deterministic step function of CALENDAR days until the exam
 * in the STUDENT'S timezone (spec AI: a "tomorrow" exam is tomorrow where
 * the student sits, never in a hard-coded zone; storage stays UTC). Uses the
 * domain's timezone-safe `calendarDaysBetween` — the same math the exam
 * countdown UI uses — so scheduling and display can never disagree.
 *
 * Exam scope (spec M): `exam_modules` relates exams to modules, but M3–M7
 * documents (and therefore concepts) carry no module link, so concept-level
 * exam scope cannot be derived yet. v1 applies exam urgency course-wide and
 * keeps the manual-adjustment path open: `examScope.conceptIds`, when
 * provided, restricts relevance to those concepts.
 */

import { calendarDaysBetween } from '@avidia/domain';
import { EXAM_URGENCY_BEYOND, EXAM_URGENCY_STEPS, PRIORITY } from './config';

export interface UpcomingExam {
  examId: string;
  /** UTC instant of the exam (ISO). */
  examAt: string;
  /** Optional explicit concept scope (spec M manual-adjustment path). */
  conceptIds?: readonly string[] | null;
}

/**
 * Urgency in [0, 1] for an exam, or null when the exam is in the past
 * (past exams contribute nothing, spec L).
 */
export function examUrgency(exam: UpcomingExam, now: Date, timeZone: string): number | null {
  const examDate = new Date(Date.parse(exam.examAt));
  if (Number.isNaN(examDate.getTime())) return null;
  const days = calendarDaysBetween(now, examDate, timeZone);
  if (days < 0) return null;
  for (const step of EXAM_URGENCY_STEPS) {
    if (days <= step.maxDays) return step.urgency;
  }
  return EXAM_URGENCY_BEYOND;
}

/**
 * The exam-relevance factor for one concept (spec L/M/O):
 * 1.0 when no exam applies or the concept is out of scope;
 * 1 + EXAM_URGENCY_SCALE × urgency of the most urgent in-scope exam.
 */
export function examRelevanceFactor(
  conceptId: string,
  exams: readonly UpcomingExam[],
  now: Date,
  timeZone: string
): { factor: number; urgentExamId: string | null } {
  let best = 0;
  let bestId: string | null = null;
  for (const exam of exams) {
    if (exam.conceptIds != null && !exam.conceptIds.includes(conceptId)) continue;
    const urgency = examUrgency(exam, now, timeZone);
    if (urgency !== null && urgency > best) {
      best = urgency;
      bestId = exam.examId;
    }
  }
  if (bestId === null) return { factor: 1, urgentExamId: null };
  return { factor: 1 + PRIORITY.EXAM_URGENCY_SCALE * best, urgentExamId: bestId };
}
