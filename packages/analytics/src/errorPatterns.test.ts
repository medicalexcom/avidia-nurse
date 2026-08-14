import { computeErrorPatterns } from './errorPatterns';
import { attempt, resetFixtureIds } from './fixtures';

beforeEach(resetFixtureIds);

describe('deterministic error patterns (spec AB)', () => {
  it('no errors → no patterns', () => {
    expect(computeErrorPatterns([attempt({ isCorrect: true })])).toEqual([]);
  });

  it('requires the minimum evidence before naming a pattern', () => {
    const twoMisses = [
      attempt({ isCorrect: false, confidence: 'certain' }),
      attempt({ isCorrect: false, confidence: 'certain' }),
    ];
    expect(computeErrorPatterns(twoMisses)).toEqual([]);
  });

  it('flags high-confidence misses past the gate', () => {
    const attempts = [
      ...Array.from({ length: 3 }, () => attempt({ isCorrect: false, confidence: 'certain' })),
      ...Array.from({ length: 5 }, () => attempt({ isCorrect: true })),
    ];
    const patterns = computeErrorPatterns(attempts);
    expect(patterns.map((p) => p.code)).toContain('high_confidence_misses');
  });

  it('cluster patterns need a MAJORITY of misses, not just a count', () => {
    // 3 prioritization misses out of 10 total misses — not a cluster.
    const attempts = [
      ...Array.from({ length: 3 }, () =>
        attempt({ isCorrect: false, cognitiveLevel: 'prioritization', conceptId: null })
      ),
      ...Array.from({ length: 7 }, (_, i) =>
        attempt({ isCorrect: false, cognitiveLevel: 'recall', conceptId: `c-${i}` })
      ),
    ];
    expect(computeErrorPatterns(attempts).map((p) => p.code)).not.toContain(
      'prioritization_misses'
    );

    // 4 of 6 misses are prioritization — that is a cluster.
    const clustered = [
      ...Array.from({ length: 4 }, () =>
        attempt({ isCorrect: false, cognitiveLevel: 'prioritization', conceptId: null })
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        attempt({ isCorrect: false, cognitiveLevel: 'recall', conceptId: `x-${i}` })
      ),
    ];
    expect(computeErrorPatterns(clustered).map((p) => p.code)).toContain('prioritization_misses');
  });

  it('identifies the most-missed concept deterministically', () => {
    const attempts = [
      ...Array.from({ length: 4 }, () => attempt({ isCorrect: false, conceptId: 'c-repeat' })),
      attempt({ isCorrect: false, conceptId: 'c-other' }),
    ];
    const pattern = computeErrorPatterns(attempts).find((p) => p.code === 'repeat_concept_misses');
    expect(pattern?.conceptId).toBe('c-repeat');
    expect(pattern?.evidenceCount).toBe(4);
  });
});
