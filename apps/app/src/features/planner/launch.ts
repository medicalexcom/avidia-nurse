import type { PlanActivityType, PlanReason } from '@avidia/planner';

/**
 * Pure presentation helpers for planned activities — M13 (spec M/O/V).
 * Kept out of the screen so labels, routes and reason copy are unit-testable.
 */

/** Student-facing labels for every plannable experience (spec M). */
export const ACTIVITY_TYPE_LABELS: Record<PlanActivityType, string> = {
  start_today: 'Adaptive study',
  due_review: 'Review session',
  targeted_practice: 'Targeted practice',
  rapid_response: 'Rapid Response',
  medication_lab: 'Medication Lab',
  priority_challenge: 'Priority Challenge',
  find_the_danger: 'Find the Danger',
  boss_battle: 'Boss Battle',
  simulation: 'Patient simulation',
};

/** Plain-language reason copy (spec O) — transparent, never judgmental. */
export const PLAN_REASON_LABELS: Record<PlanReason['code'], string> = {
  exam_soon: 'Exam coming up',
  low_mastery: 'Needs strengthening',
  review_due: 'Review due',
  misconception_signal: 'Clearing up a mix-up',
  coverage_gap: 'Not assessed yet',
  higher_order_gap: 'Build application skill',
  clinical_practice: 'Clinical practice',
  keep_fresh: 'Keep it fresh',
};

export function reasonLine(reasons: readonly PlanReason[]): string {
  const first = reasons[0];
  if (!first) return '';
  if (first.code === 'exam_soon' && typeof first.daysUntilExam === 'number') {
    const days = first.daysUntilExam;
    if (days === 0) return 'Exam today';
    if (days === 1) return 'Exam tomorrow';
    return `Exam in ${days} days`;
  }
  return PLAN_REASON_LABELS[first.code];
}

/**
 * The in-app route that launches an activity — always one of the EXISTING
 * experiences (spec M/Y): adaptive/practice sessions, an M10 mode, or the
 * M11 simulation. Nothing new is invented for the planner.
 */
export function activityLaunchRoute(activity: {
  courseId: string;
  type: PlanActivityType;
  modeId: string | null;
  minutes: number;
}): string {
  switch (activity.type) {
    case 'start_today':
    case 'due_review':
    case 'targeted_practice':
      return `/course/${activity.courseId}/practice?mode=adaptive&minutes=${activity.minutes}`;
    case 'priority_challenge':
      return `/course/${activity.courseId}/practice?mode=${activity.modeId ?? 'who_first'}`;
    case 'simulation':
      return `/course/${activity.courseId}/simulation`;
    default:
      return `/course/${activity.courseId}/practice?mode=${activity.type}`;
  }
}
