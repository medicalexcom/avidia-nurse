import {
  DROP_CAP,
  GAIN_CAP,
  MASTERY_ALGORITHM_VERSION,
  REVIEW_INTERVALS_HOURS,
  WEIGHT_RANGE,
} from './config';
import {
  evidenceWeight,
  hasMisconceptionSignal,
  initialAggregate,
  nextMisconceptionSeverity,
  nextReviewStage,
  reviewIntervalHours,
  updateMastery,
  type MasteryAggregate,
  type PerformanceEvent,
} from './update';

const T0 = '2026-08-13T12:00:00.000Z';

function event(overrides: Partial<PerformanceEvent> = {}): PerformanceEvent {
  return {
    isCorrect: true,
    difficulty: 'moderate',
    cognitiveLevel: 'application',
    confidence: null,
    answeredAt: T0,
    ...overrides,
  };
}

describe('evidenceWeight (spec F/G/H/I)', () => {
  it('weights a correct hard answer above a correct easy one (spec F)', () => {
    const hard = evidenceWeight(event({ difficulty: 'hard' }));
    const easy = evidenceWeight(event({ difficulty: 'easy' }));
    expect(hard).toBeGreaterThan(easy);
  });

  it('weights an incorrect easy answer above an incorrect hard one (spec F)', () => {
    const easy = evidenceWeight(event({ isCorrect: false, difficulty: 'easy' }));
    const hard = evidenceWeight(event({ isCorrect: false, difficulty: 'hard' }));
    expect(easy).toBeGreaterThan(hard);
  });

  it('weights correct higher-order answers above recall (spec G)', () => {
    const prioritization = evidenceWeight(event({ cognitiveLevel: 'prioritization' }));
    const recall = evidenceWeight(event({ cognitiveLevel: 'recall' }));
    expect(prioritization).toBeGreaterThan(recall);
  });

  it('does not amplify incorrect answers by cognitive level (spec G)', () => {
    const analysis = evidenceWeight(event({ isCorrect: false, cognitiveLevel: 'analysis' }));
    const recall = evidenceWeight(event({ isCorrect: false, cognitiveLevel: 'recall' }));
    expect(analysis).toBe(recall);
  });

  it('discounts a correct guess heavily (spec H)', () => {
    const guess = evidenceWeight(event({ confidence: 'guessing' }));
    const certain = evidenceWeight(event({ confidence: 'certain' }));
    expect(guess).toBeLessThan(certain);
  });

  it('amplifies confident errors over admitted uncertainty (spec H)', () => {
    const certainWrong = evidenceWeight(event({ isCorrect: false, confidence: 'certain' }));
    const guessingWrong = evidenceWeight(event({ isCorrect: false, confidence: 'guessing' }));
    expect(certainWrong).toBeGreaterThan(guessingWrong);
  });

  it('treats null confidence as neutral (spec H)', () => {
    expect(evidenceWeight(event({ confidence: null, cognitiveLevel: 'application' }))).toBeCloseTo(
      1.1,
      6
    );
  });

  it('is clamped to the configured range (bounded influence)', () => {
    const extremes: PerformanceEvent[] = [
      event({ difficulty: 'hard', cognitiveLevel: 'prioritization', confidence: 'certain' }),
      event({ isCorrect: false, difficulty: 'hard', confidence: 'guessing' }),
    ];
    for (const e of extremes) {
      const w = evidenceWeight(e);
      expect(w).toBeGreaterThanOrEqual(WEIGHT_RANGE.min);
      expect(w).toBeLessThanOrEqual(WEIGHT_RANGE.max);
    }
  });
});

describe('updateMastery (spec D/E/AB/AK)', () => {
  it('starts from an explicit zero-evidence state (spec C)', () => {
    expect(initialAggregate()).toEqual({
      mastery: 0,
      attemptsCount: 0,
      correctCount: 0,
      misconceptionSeverity: 0,
      reviewStage: 0,
      lastAttemptAt: null,
      nextReviewAt: null,
    });
  });

  it('one correct answer never claims mastery (spec E)', () => {
    const { aggregate } = updateMastery(
      initialAggregate(),
      event({ difficulty: 'hard', cognitiveLevel: 'prioritization', confidence: 'certain' })
    );
    expect(aggregate.mastery).toBeLessThanOrEqual(GAIN_CAP);
    expect(aggregate.mastery).toBeGreaterThan(0);
  });

  it('caps every single-step gain and drop (spec AK)', () => {
    const up = updateMastery(
      { ...initialAggregate(), mastery: 0.1 },
      event({ difficulty: 'hard', cognitiveLevel: 'prioritization', confidence: 'certain' })
    );
    expect(up.masteryDelta).toBeLessThanOrEqual(GAIN_CAP);
    const down = updateMastery(
      { ...initialAggregate(), mastery: 0.95, attemptsCount: 5 },
      event({ isCorrect: false, difficulty: 'easy', confidence: 'certain' })
    );
    expect(Math.abs(down.masteryDelta)).toBeLessThanOrEqual(DROP_CAP);
  });

  it('gains shrink as mastery rises (diminishing returns, spec E)', () => {
    const lowGain = updateMastery({ ...initialAggregate(), mastery: 0.2 }, event()).masteryDelta;
    const highGain = updateMastery({ ...initialAggregate(), mastery: 0.9 }, event()).masteryDelta;
    expect(lowGain).toBeGreaterThan(highGain);
  });

  it('an incorrect answer at zero mastery still stays within [0, 1]', () => {
    const { aggregate } = updateMastery(initialAggregate(), event({ isCorrect: false }));
    expect(aggregate.mastery).toBe(0);
  });

  it('mastery always stays within [0, 1] and finite (spec AK)', () => {
    let agg = initialAggregate();
    const events = [
      event({ confidence: 'certain', difficulty: 'hard', cognitiveLevel: 'prioritization' }),
      event({ isCorrect: false, confidence: 'certain', difficulty: 'easy' }),
      event({ confidence: 'guessing', difficulty: 'easy', cognitiveLevel: 'recall' }),
    ];
    for (let i = 0; i < 50; i++) {
      agg = updateMastery(agg, events[i % events.length]!).aggregate;
      expect(agg.mastery).toBeGreaterThanOrEqual(0);
      expect(agg.mastery).toBeLessThanOrEqual(1);
      expect(Number.isFinite(agg.mastery)).toBe(true);
      expect(Number.isNaN(agg.mastery)).toBe(false);
    }
  });

  it('is deterministic: identical inputs produce identical outputs (spec AB)', () => {
    const prev: MasteryAggregate = {
      mastery: 0.42,
      attemptsCount: 7,
      correctCount: 4,
      misconceptionSeverity: 0.3,
      reviewStage: 2,
      lastAttemptAt: T0,
      nextReviewAt: '2026-08-20T12:00:00.000Z',
    };
    const e = event({ confidence: 'pretty_sure', difficulty: 'hard' });
    expect(updateMastery(prev, e)).toEqual(updateMastery(prev, e));
  });

  it('increments counters and stamps timestamps from the event, not a clock', () => {
    const { aggregate } = updateMastery(initialAggregate(), event());
    expect(aggregate.attemptsCount).toBe(1);
    expect(aggregate.correctCount).toBe(1);
    expect(aggregate.lastAttemptAt).toBe(T0);
    expect(aggregate.nextReviewAt).toBe('2026-08-16T12:00:00.000Z'); // stage 1 = 72h
  });

  it('reports the algorithm version on every result (spec AA)', () => {
    expect(updateMastery(initialAggregate(), event()).algorithmVersion).toBe(
      MASTERY_ALGORITHM_VERSION
    );
  });

  it('golden values pin the SQL mirror (contract test)', () => {
    // moderate/application/null-confidence correct from zero:
    // w = 1.0 × 1.1 × 1.0 = 1.1; delta = min(0.3 × 1.1 × 1, 0.25) = 0.25
    const a = updateMastery(initialAggregate(), event());
    expect(a.aggregate.mastery).toBeCloseTo(0.25, 6);
    // incorrect easy/certain at 0.5:
    // w = clamp(1.25 × 1.0 × 1.15) = 1.4375; drop = min(0.4 × 1.4375 × 0.5, 0.3) = 0.2875
    const b = updateMastery(
      { ...initialAggregate(), mastery: 0.5, attemptsCount: 3 },
      event({ isCorrect: false, difficulty: 'easy', confidence: 'certain' })
    );
    expect(b.aggregate.mastery).toBeCloseTo(0.2125, 6);
    // correct guess easy/recall at 0.2: w = clamp(0.8 × 0.85 × 0.55) = 0.374
    // gain = 0.3 × 0.374 × 0.8 = 0.08976
    const c = updateMastery(
      { ...initialAggregate(), mastery: 0.2, attemptsCount: 2 },
      event({ difficulty: 'easy', cognitiveLevel: 'recall', confidence: 'guessing' })
    );
    expect(c.aggregate.mastery).toBeCloseTo(0.28976, 5);
  });
});

describe('misconception severity (spec R)', () => {
  it('accumulates fastest from certain-incorrect answers', () => {
    const certain = nextMisconceptionSeverity(
      0,
      event({ isCorrect: false, confidence: 'certain' })
    );
    const unsure = nextMisconceptionSeverity(0, event({ isCorrect: false, confidence: 'unsure' }));
    expect(certain).toBeGreaterThan(unsure);
  });

  it('decays on correct answers instead of resetting', () => {
    const decayed = nextMisconceptionSeverity(0.6, event());
    expect(decayed).toBeCloseTo(0.3, 6);
    expect(decayed).toBeGreaterThan(0);
  });

  it('clamps to [0, 1]', () => {
    expect(
      nextMisconceptionSeverity(0.95, event({ isCorrect: false, confidence: 'certain' }))
    ).toBe(1);
  });

  it('signals at the configured threshold', () => {
    expect(hasMisconceptionSignal(0.5)).toBe(true);
    expect(hasMisconceptionSignal(0.49)).toBe(false);
  });

  it('two confident errors reach the signal threshold (spec R: repeated pattern)', () => {
    let severity = 0;
    severity = nextMisconceptionSeverity(
      severity,
      event({ isCorrect: false, confidence: 'certain' })
    );
    expect(hasMisconceptionSignal(severity)).toBe(false); // one error is not a pattern
    severity = nextMisconceptionSeverity(
      severity,
      event({ isCorrect: false, confidence: 'certain' })
    );
    expect(hasMisconceptionSignal(severity)).toBe(true);
  });
});

describe('review scheduling (spec K)', () => {
  it('advances one stage on a confident correct answer', () => {
    expect(nextReviewStage(0, event())).toBe(1);
    expect(nextReviewStage(2, event({ confidence: 'certain' }))).toBe(3);
  });

  it('a lucky guess earns no schedule relief', () => {
    expect(nextReviewStage(2, event({ confidence: 'guessing' }))).toBe(2);
  });

  it('resets to stage 0 on incorrect', () => {
    expect(nextReviewStage(4, event({ isCorrect: false }))).toBe(0);
  });

  it('saturates at the last interval', () => {
    expect(nextReviewStage(REVIEW_INTERVALS_HOURS.length - 1, event())).toBe(
      REVIEW_INTERVALS_HOURS.length - 1
    );
  });

  it('uses the documented nursing-rhythm intervals (1/3/7/14/30 days)', () => {
    expect(REVIEW_INTERVALS_HOURS).toEqual([24, 72, 168, 336, 720]);
    expect(reviewIntervalHours(0)).toBe(24);
    expect(reviewIntervalHours(99)).toBe(720);
    expect(reviewIntervalHours(-1)).toBe(24);
  });
});
