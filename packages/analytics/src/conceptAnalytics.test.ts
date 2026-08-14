import { computeConceptAnalytics } from './conceptAnalytics';
import {
  FIXED_NOW,
  TZ,
  attempt,
  concept,
  daysAgo,
  masteryRecord,
  resetFixtureIds,
} from './fixtures';

beforeEach(resetFixtureIds);

describe('per-concept analytics (spec F/H/I/M)', () => {
  it('unassessed concepts are NEVER in needs-attention (spec H)', () => {
    const result = computeConceptAnalytics(
      [concept({ conceptId: 'c-1' }), concept({ conceptId: 'c-2' })],
      [],
      [],
      FIXED_NOW,
      TZ
    );
    expect(result.needsAttention).toHaveLength(0);
    expect(result.concepts.every((c) => c.state === 'unassessed')).toBe(true);
  });

  it('flags evidence-backed problems with coded reasons', () => {
    const attempts = Array.from({ length: 4 }, (_, i) =>
      attempt({ conceptId: 'c-1', isCorrect: false, confidence: 'certain', createdAt: daysAgo(i) })
    );
    const result = computeConceptAnalytics(
      [concept({ conceptId: 'c-1', canonicalName: 'Digoxin toxicity' })],
      [
        masteryRecord('c-1', {
          mastery: 0.15,
          attemptsCount: 4,
          correctCount: 0,
          misconceptionSeverity: 0.7,
          nextReviewAt: daysAgo(-3),
        }),
      ],
      attempts,
      FIXED_NOW,
      TZ
    );
    expect(result.needsAttention).toHaveLength(1);
    const row = result.needsAttention[0]!;
    expect(row.attentionReasons).toContain('misconception_signal');
    expect(row.attentionReasons).toContain('high_confidence_errors');
    expect(row.attentionReasons).toContain('low_mastery');
    expect(row.misconceptionSignal).toBe(true);
    expect(row.highConfidenceErrorCount).toBe(4);
  });

  it('below the concept evidence gate, no attention reasons are raised', () => {
    const result = computeConceptAnalytics(
      [concept({ conceptId: 'c-1' })],
      [
        masteryRecord('c-1', {
          mastery: 0.1,
          attemptsCount: 2,
          correctCount: 0,
          misconceptionSeverity: 0.9,
          nextReviewAt: daysAgo(-3),
        }),
      ],
      [attempt({ conceptId: 'c-1', isCorrect: false })],
      FIXED_NOW,
      TZ
    );
    expect(result.needsAttention).toHaveLength(0);
  });

  it('strengths require strong state AND sufficient attempts (spec I)', () => {
    const result = computeConceptAnalytics(
      [concept({ conceptId: 'c-1' }), concept({ conceptId: 'c-2' })],
      [
        masteryRecord('c-1', {
          mastery: 0.9,
          attemptsCount: 6,
          correctCount: 6,
          nextReviewAt: daysAgo(-5),
        }),
        masteryRecord('c-2', {
          mastery: 0.9,
          attemptsCount: 2, // below MIN_STRENGTH_ATTEMPTS
          correctCount: 2,
          nextReviewAt: daysAgo(-5),
        }),
      ],
      [],
      FIXED_NOW,
      TZ
    );
    expect(result.strengths.map((s) => s.conceptId)).toEqual(['c-1']);
  });

  it('recent accuracy appears only past the per-concept gate (spec F/AJ)', () => {
    const twoAttempts = [
      attempt({ conceptId: 'c-1', isCorrect: true, createdAt: daysAgo(1) }),
      attempt({ conceptId: 'c-1', isCorrect: false, createdAt: daysAgo(2) }),
    ];
    const sparse = computeConceptAnalytics(
      [concept({ conceptId: 'c-1' })],
      [],
      twoAttempts,
      FIXED_NOW,
      TZ
    );
    expect(sparse.concepts[0]!.recentAccuracy).toBeNull();

    const enough = computeConceptAnalytics(
      [concept({ conceptId: 'c-1' })],
      [],
      [...twoAttempts, attempt({ conceptId: 'c-1', isCorrect: true, createdAt: daysAgo(3) })],
      FIXED_NOW,
      TZ
    );
    expect(enough.concepts[0]!.recentAccuracy).toEqual({
      correct: 2,
      total: 3,
      accuracy: 2 / 3,
    });
  });

  it('breaks down accuracy per cognitive level from stored metadata', () => {
    const result = computeConceptAnalytics(
      [concept({ conceptId: 'c-1' })],
      [],
      [
        attempt({ conceptId: 'c-1', cognitiveLevel: 'recall', isCorrect: true }),
        attempt({ conceptId: 'c-1', cognitiveLevel: 'recall', isCorrect: true }),
        attempt({ conceptId: 'c-1', cognitiveLevel: 'prioritization', isCorrect: false }),
      ],
      FIXED_NOW,
      TZ
    );
    const row = result.concepts[0]!;
    expect(row.byCognitiveLevel.recall).toEqual({ correct: 2, total: 2, accuracy: 1 });
    expect(row.byCognitiveLevel.prioritization).toEqual({ correct: 0, total: 1, accuracy: 0 });
    expect(row.byCognitiveLevel.analysis).toBeUndefined();
  });
});
