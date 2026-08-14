import { forgettingRisk, priorityFactors, priorityScore, type PriorityInput } from './priority';
import { initialAggregate, type MasteryAggregate } from './update';

const NOW = new Date('2026-08-13T12:00:00.000Z');

function assessed(overrides: Partial<MasteryAggregate> = {}): MasteryAggregate {
  return {
    ...initialAggregate(),
    attemptsCount: 5,
    correctCount: 3,
    mastery: 0.5,
    lastAttemptAt: '2026-08-12T12:00:00.000Z',
    nextReviewAt: '2026-08-15T12:00:00.000Z',
    ...overrides,
  };
}

function input(overrides: Partial<PriorityInput> = {}): PriorityInput {
  return {
    aggregate: assessed(),
    examRelevance: 1,
    normalizedEmphasis: 0,
    hasHigherOrderCorrect: true,
    now: NOW,
    ...overrides,
  };
}

describe('forgettingRisk (spec J/K)', () => {
  it('grows with elapsed fraction of the review interval', () => {
    const early = forgettingRisk(assessed(), new Date('2026-08-12T18:00:00.000Z'));
    const late = forgettingRisk(assessed(), new Date('2026-08-14T18:00:00.000Z'));
    expect(late).toBeGreaterThan(early);
  });

  it('saturates at 1 when due or overdue', () => {
    expect(forgettingRisk(assessed(), new Date('2026-08-15T12:00:00.000Z'))).toBe(1);
    expect(forgettingRisk(assessed(), new Date('2026-09-15T12:00:00.000Z'))).toBe(1);
  });

  it('keeps a floor right after review', () => {
    expect(forgettingRisk(assessed(), new Date('2026-08-12T12:00:01.000Z'))).toBe(0.15);
  });
});

describe('priorityFactors / priorityScore (spec O/P)', () => {
  it('unassessed concepts get full weakness but moderated risk (spec X)', () => {
    const factors = priorityFactors(input({ aggregate: null }));
    expect(factors.weakness).toBe(1);
    expect(factors.forgettingRisk).toBe(0.6);
    expect(factors.misconceptionMultiplier).toBe(1);
  });

  it('weakness decreases with mastery but never reaches zero', () => {
    const weak = priorityFactors(input({ aggregate: assessed({ mastery: 0.1 }) }));
    const strong = priorityFactors(input({ aggregate: assessed({ mastery: 1 }) }));
    expect(weak.weakness).toBeGreaterThan(strong.weakness);
    expect(strong.weakness).toBeCloseTo(0.15, 6);
  });

  it('misconception severity multiplies priority (spec R)', () => {
    const clean = priorityScore(input()).score;
    const misconceived = priorityScore(
      input({ aggregate: assessed({ misconceptionSeverity: 0.8 }) })
    ).score;
    expect(misconceived).toBeGreaterThan(clean);
  });

  it('emphasis boosts but is bounded (spec N)', () => {
    const none = priorityFactors(input({ normalizedEmphasis: 0 }));
    const max = priorityFactors(input({ normalizedEmphasis: 1 }));
    expect(none.emphasisFactor).toBe(1);
    expect(max.emphasisFactor).toBe(1.5);
    const overflow = priorityFactors(input({ normalizedEmphasis: 42 }));
    expect(overflow.emphasisFactor).toBe(1.5); // clamped
  });

  it('transfer need applies only to developing-or-better without higher-order evidence', () => {
    const needsTransfer = priorityFactors(
      input({ aggregate: assessed({ mastery: 0.6 }), hasHigherOrderCorrect: false })
    );
    expect(needsTransfer.transferNeed).toBe(1.25);
    const lowMastery = priorityFactors(
      input({ aggregate: assessed({ mastery: 0.2 }), hasHigherOrderCorrect: false })
    );
    expect(lowMastery.transferNeed).toBe(1); // fundamentals first
  });

  it('an urgent exam elevates a weak concept above an equally weak non-exam one (spec AK F)', () => {
    const onExam = priorityScore(
      input({ aggregate: assessed({ mastery: 0.2 }), examRelevance: 2.425 })
    );
    const offExam = priorityScore(
      input({ aggregate: assessed({ mastery: 0.2 }), examRelevance: 1 })
    );
    expect(onExam.score).toBeGreaterThan(offExam.score);
  });

  it('is deterministic and finite (spec AB/AK)', () => {
    const a = priorityScore(input());
    const b = priorityScore(input());
    expect(a).toEqual(b);
    expect(Number.isFinite(a.score)).toBe(true);
  });
});
