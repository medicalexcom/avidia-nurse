import { describe, it, expect } from '@jest/globals';
import type { ConfidenceLevel, ReviewAttempt } from '@avidia/domain';
import {
  calculateNextReview,
  getReviewUrgency,
  updateReviewScheduleAfterAttempt,
  REVIEW_INTERVALS,
  initialAggregate,
  type MasteryAggregate,
} from '@avidia/mastery';

const T0 = '2026-08-13T12:00:00.000Z';

function attempt(overrides: Partial<ReviewAttempt> = {}): ReviewAttempt {
  return {
    conceptId: 'concept-glucose',
    correct: true,
    confidence: null,
    responseTimeMs: 4000,
    masteryBefore: 0.5,
    masteryAfter: 0.55,
    answeredAt: T0,
    ...overrides,
  };
}

function aggregate(overrides: Partial<MasteryAggregate> = {}): MasteryAggregate {
  return { ...initialAggregate(), mastery: 0.5, ...overrides };
}

function hoursAfter(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 3600_000).toISOString();
}

describe('SKILL #4: calculateNextReview', () => {
  it('advances on correct high-confidence answers', () => {
    expect(calculateNextReview(2, true, 'certain', T0).nextStage).toBe(3);
  });

  it('holds on correct neutral-confidence answers', () => {
    expect(calculateNextReview(2, true, 'pretty_sure', T0).nextStage).toBe(2);
  });

  it('backs off on correct low-confidence answers', () => {
    expect(calculateNextReview(2, true, 'unsure', T0).nextStage).toBe(1);
  });

  it('backs off two stages for confident misconceptions', () => {
    const confidentWrong = calculateNextReview(4, false, 'certain', T0);
    const unsureWrong = calculateNextReview(4, false, 'unsure', T0);
    expect(confidentWrong.nextStage).toBe(2);
    expect(unsureWrong.nextStage).toBe(3);
  });
});

describe('SKILL #4: getReviewUrgency', () => {
  it('returns due_now for overdue reviews', () => {
    expect(getReviewUrgency(hoursAfter(T0, -1), T0)).toBe('due_now');
  });

  it('returns due_soon within one hour', () => {
    expect(getReviewUrgency(hoursAfter(T0, 0.5), T0)).toBe('due_soon');
  });

  it('returns upcoming within 24 hours', () => {
    expect(getReviewUrgency(hoursAfter(T0, 12), T0)).toBe('upcoming');
  });

  it('returns unlocked beyond 24 hours', () => {
    expect(getReviewUrgency(hoursAfter(T0, 48), T0)).toBe('unlocked');
  });

  it('treats null as immediately due', () => {
    expect(getReviewUrgency(null, T0)).toBe('due_now');
  });
});

describe('SKILL #4: edge cases', () => {
  it('never drops below stage 0', () => {
    expect(calculateNextReview(0, false, 'certain', T0).nextStage).toBe(0);
  });

  it('caps at stage 8 and six weeks', () => {
    const result = calculateNextReview(8, true, 'certain', T0);
    expect(result.nextStage).toBe(8);
    expect(result.nextReviewAt).toBe(hoursAfter(T0, REVIEW_INTERVALS[8]!));
    expect(REVIEW_INTERVALS[8]).toBe(1512);
  });
});

describe('SKILL #4: learning journeys', () => {
  it('advances through stages with correct confident answers', () => {
    let mastery = aggregate({ reviewStage: 0 });
    let now = T0;
    const confidences: ConfidenceLevel[] = ['certain', 'certain', 'certain', 'certain'];

    for (const confidence of confidences) {
      const schedule = updateReviewScheduleAfterAttempt(
        attempt({ correct: true, confidence, answeredAt: now }),
        mastery
      );
      expect(schedule.reviewStage).toBe(mastery.reviewStage + 1);
      mastery = aggregate({ reviewStage: schedule.reviewStage });
      now = schedule.dueAt!;
    }

    expect(mastery.reviewStage).toBe(4);
  });

  it('backs off for repeated confident misconceptions', () => {
    let mastery = aggregate({ reviewStage: 6 });
    const first = updateReviewScheduleAfterAttempt(
      attempt({ correct: false, confidence: 'certain', answeredAt: T0 }),
      mastery
    );
    expect(first.reviewStage).toBe(4);

    mastery = aggregate({ reviewStage: first.reviewStage });
    const second = updateReviewScheduleAfterAttempt(
      attempt({ correct: false, confidence: 'certain', answeredAt: first.dueAt! }),
      mastery
    );
    expect(second.reviewStage).toBe(2);
  });

  it('handles a mixed sequence', () => {
    let mastery = aggregate({ reviewStage: 3 });
    const step1 = updateReviewScheduleAfterAttempt(
      attempt({ correct: true, confidence: 'certain', answeredAt: T0 }),
      mastery
    );
    expect(step1.reviewStage).toBe(4);

    mastery = aggregate({ reviewStage: step1.reviewStage });
    const step2 = updateReviewScheduleAfterAttempt(
      attempt({ correct: false, confidence: 'unsure', answeredAt: step1.dueAt! }),
      mastery
    );
    expect(step2.reviewStage).toBe(3);

    mastery = aggregate({ reviewStage: step2.reviewStage });
    const step3 = updateReviewScheduleAfterAttempt(
      attempt({ correct: true, confidence: 'pretty_sure', answeredAt: step2.dueAt! }),
      mastery
    );
    expect(step3.reviewStage).toBe(3);
    expect(getReviewUrgency(step3.dueAt, step2.dueAt!)).not.toBe('due_now');
  });
});
