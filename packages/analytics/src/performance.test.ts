/**
 * Performance test — M12 (spec AV): the full analytics computation over a
 * realistic heavy course (thousands of attempts, hundreds of concepts)
 * completes quickly. The bound is generous to avoid CI flakiness; the point
 * is catching accidental O(n²)-per-attempt regressions, not micro-tuning.
 */

import { getCourseAnalytics } from './overview';
import { FIXED_NOW, TZ, concept, input, masteryRecord, simulation } from './fixtures';
import type { AttemptRecord } from './types';

describe('performance (spec AV)', () => {
  it('handles 5,000 attempts across 200 concepts well under a second', () => {
    const concepts = Array.from({ length: 200 }, (_, i) =>
      concept({ conceptId: `c-${i}`, canonicalName: `Concept ${i}` })
    );
    const mastery = concepts.map((c, i) =>
      masteryRecord(c.conceptId, {
        mastery: (i % 10) / 10,
        attemptsCount: 5 + (i % 7),
        correctCount: 3,
        nextReviewAt: i % 3 === 0 ? '2026-08-10T00:00:00Z' : '2026-08-20T00:00:00Z',
      })
    );
    const levels = [
      'recall',
      'understanding',
      'application',
      'analysis',
      'prioritization',
    ] as const;
    const difficulties = ['easy', 'moderate', 'hard'] as const;
    const confidences = ['guessing', 'unsure', 'pretty_sure', 'certain', null] as const;
    const attempts: AttemptRecord[] = Array.from({ length: 5000 }, (_, i) => ({
      attemptId: `a-${i}`,
      questionId: `q-${i % 900}`,
      conceptId: `c-${i % 200}`,
      isCorrect: i % 3 !== 0,
      confidence: confidences[i % 5]!,
      difficulty: difficulties[i % 3]!,
      cognitiveLevel: levels[i % 5]!,
      questionType: i % 11 === 0 ? 'numeric_calculation' : 'sba',
      sessionType: i % 4 === 0 ? 'who_first' : 'adaptive',
      createdAt: new Date(FIXED_NOW.getTime() - (i % 60) * 86400_000 - i * 1000).toISOString(),
    }));
    const simulations = Array.from({ length: 25 }, (_, i) =>
      simulation({
        sessionId: `sim-${i}`,
        completedAt: new Date(FIXED_NOW.getTime() - i * 86400_000).toISOString(),
      })
    );

    const heavy = input({ attempts, mastery, concepts, simulations, timeZone: TZ });
    const started = Date.now();
    const result = getCourseAnalytics(heavy);
    const elapsed = Date.now() - started;

    expect(result.conceptAnalytics.concepts).toHaveLength(200);
    expect(result.consistency.attemptsLast30).toBeGreaterThan(0);
    // Generous bound: the engine runs in well under a second in isolation, but
    // this test shares CPU with every other package's jest workers in CI. The
    // bound exists to catch accidental O(n²) regressions, not to benchmark.
    expect(elapsed).toBeLessThan(6000);
  });
});
