/**
 * Mastery-state resolution — M8 (spec B/C/J/Q).
 *
 * Maps the internal 0–1 evidence score plus the review schedule to the five
 * student-facing states. MASTERY EVIDENCE and REVIEW URGENCY stay separate
 * (spec J): being overdue overlays `due_for_review` without erasing the
 * underlying evidence, and the underlying band is still available to
 * callers that need it (e.g. question-characteristic targeting).
 */

import type { MasteryState } from '@avidia/domain';
import { STATE_THRESHOLDS } from './config';
import type { MasteryAggregate } from './update';

/** The evidence band ignoring the review schedule (spec J). */
export function masteryBand(mastery: number): 'needs_review' | 'developing' | 'strong' {
  if (mastery < STATE_THRESHOLDS.NEEDS_REVIEW_BELOW) return 'needs_review';
  if (mastery < STATE_THRESHOLDS.STRONG_AT) return 'developing';
  return 'strong';
}

/**
 * The student-facing state (spec C/Q): no aggregate row (or zero attempts)
 * means `unassessed` — never "needs review"; an assessed concept whose
 * next-review time has passed shows `due_for_review` regardless of band.
 */
export function masteryState(aggregate: MasteryAggregate | null, now: Date): MasteryState {
  if (aggregate === null || aggregate.attemptsCount === 0) return 'unassessed';
  if (aggregate.nextReviewAt !== null && now.getTime() >= Date.parse(aggregate.nextReviewAt)) {
    return 'due_for_review';
  }
  return masteryBand(aggregate.mastery);
}
