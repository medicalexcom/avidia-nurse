import {
  MASTERY_STATES,
  MASTERY_STATE_LABELS,
  MASTERY_STATE_DESCRIPTIONS,
  isMasteryState,
  RECOMMENDATION_REASONS,
  RECOMMENDATION_REASON_LABELS,
  isRecommendationReason,
} from './mastery';

describe('mastery states (spec B/C/Q)', () => {
  it('covers exactly the five student-facing states', () => {
    expect(MASTERY_STATES).toEqual([
      'unassessed',
      'needs_review',
      'developing',
      'strong',
      'due_for_review',
    ]);
  });

  it('has a label and description for every state', () => {
    for (const state of MASTERY_STATES) {
      expect(MASTERY_STATE_LABELS[state]).toBeTruthy();
      expect(MASTERY_STATE_DESCRIPTIONS[state]).toBeTruthy();
    }
  });

  it('labels the unassessed state as "New", never as a failure (spec C)', () => {
    expect(MASTERY_STATE_LABELS.unassessed).toBe('New');
  });

  it('uses non-stigmatizing wording (spec Q)', () => {
    const banned = /weak|fail|bad|poor|behind/i;
    for (const state of MASTERY_STATES) {
      expect(MASTERY_STATE_LABELS[state]).not.toMatch(banned);
      expect(MASTERY_STATE_DESCRIPTIONS[state]).not.toMatch(banned);
    }
  });

  it('never exposes numeric precision in student-facing text (spec AG)', () => {
    for (const state of MASTERY_STATES) {
      expect(MASTERY_STATE_LABELS[state]).not.toMatch(/\d|%/);
      expect(MASTERY_STATE_DESCRIPTIONS[state]).not.toMatch(/\d|%/);
    }
  });

  it('guards state values', () => {
    expect(isMasteryState('strong')).toBe(true);
    expect(isMasteryState('mastered')).toBe(false);
    expect(isMasteryState('')).toBe(false);
  });
});

describe('recommendation reasons (spec S/T/Y)', () => {
  it('covers exactly the seven reason codes', () => {
    expect(RECOMMENDATION_REASONS).toEqual([
      'unassessed',
      'low_mastery',
      'review_due',
      'exam_soon',
      'recent_error',
      'high_course_emphasis',
      'question_supply_low',
    ]);
  });

  it('has a plain-language label for every reason', () => {
    for (const reason of RECOMMENDATION_REASONS) {
      expect(RECOMMENDATION_REASON_LABELS[reason]).toBeTruthy();
    }
  });

  it('never phrases emphasis as an exam prediction (spec N)', () => {
    expect(RECOMMENDATION_REASON_LABELS.high_course_emphasis).not.toMatch(
      /will be on|predicted|guarantee/i
    );
  });

  it('guards reason values', () => {
    expect(isRecommendationReason('review_due')).toBe(true);
    expect(isRecommendationReason('ai_says_so')).toBe(false);
  });
});
