import type { ConfidenceLevel, ReviewAttempt, ReviewSchedule, ReviewUrgency } from '@avidia/domain';
import type { MasteryAggregate } from './update';

/** Review intervals in hours for stages 0 through 8 (6 weeks max). */
export const REVIEW_INTERVALS: readonly number[] = [0, 1, 3, 8, 24, 72, 168, 504, 1512];

const MAX_STAGE = REVIEW_INTERVALS.length - 1;
const ONE_HOUR_MS = 3600_000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

function confidenceTier(confidence: ConfidenceLevel | null): 'high' | 'neutral' | 'low' {
  if (confidence === 'certain') return 'high';
  if (confidence === 'unsure' || confidence === 'guessing') return 'low';
  return 'neutral';
}

export interface NextReviewResult {
  nextStage: number;
  nextReviewAt: string;
}

export function calculateNextReview(
  currentStage: number,
  correct: boolean,
  confidence: ConfidenceLevel | null,
  now: string
): NextReviewResult {
  const tier = confidenceTier(confidence);
  let delta: number;

  if (correct) {
    delta = tier === 'high' ? 1 : tier === 'neutral' ? 0 : -1;
  } else {
    delta = tier === 'high' ? -2 : -1;
  }

  const nextStage = Math.min(MAX_STAGE, Math.max(0, currentStage + delta));
  const intervalHours = REVIEW_INTERVALS[nextStage]!;
  const nextReviewAt = new Date(Date.parse(now) + intervalHours * 3600_000).toISOString();

  return { nextStage, nextReviewAt };
}

export function getReviewUrgency(nextReviewAt: string | null, now: string): ReviewUrgency {
  if (nextReviewAt === null) return 'due_now';

  const dueMs = Date.parse(nextReviewAt);
  const nowMs = Date.parse(now);

  if (nowMs >= dueMs) return 'due_now';
  if (nowMs >= dueMs - ONE_HOUR_MS) return 'due_soon';
  if (nowMs >= dueMs - ONE_DAY_MS) return 'upcoming';
  return 'unlocked';
}

export function updateReviewScheduleAfterAttempt(
  attempt: ReviewAttempt,
  masteryAggregate: MasteryAggregate
): ReviewSchedule {
  const { nextStage, nextReviewAt } = calculateNextReview(
    masteryAggregate.reviewStage,
    attempt.correct,
    attempt.confidence,
    attempt.answeredAt
  );
  const urgency = getReviewUrgency(nextReviewAt, attempt.answeredAt);

  return {
    conceptId: attempt.conceptId,
    masteryLevel: masteryAggregate.mastery,
    reviewStage: nextStage,
    dueAt: nextReviewAt,
    urgency,
  };
}
