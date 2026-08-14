import { computeDistribution } from './distribution';
import { FIXED_NOW, concept, daysAgo, masteryRecord, resetFixtureIds } from './fixtures';

beforeEach(resetFixtureIds);

describe('mastery distribution (spec E/H)', () => {
  it('counts concepts by the five M8 states, unassessed included', () => {
    const concepts = [
      concept({ conceptId: 'c-1' }),
      concept({ conceptId: 'c-2' }),
      concept({ conceptId: 'c-3' }),
      concept({ conceptId: 'c-4' }),
      concept({ conceptId: 'c-5' }),
    ];
    const mastery = [
      masteryRecord('c-1', { mastery: 0.2, nextReviewAt: daysAgo(-5) }), // needs_review
      masteryRecord('c-2', { mastery: 0.5, nextReviewAt: daysAgo(-5) }), // developing
      masteryRecord('c-3', { mastery: 0.9, nextReviewAt: daysAgo(-5) }), // strong
      masteryRecord('c-4', { mastery: 0.9, nextReviewAt: daysAgo(1) }), // overdue
      // c-5 has no row — unassessed
    ];
    const result = computeDistribution(concepts, mastery, FIXED_NOW);
    expect(result.distribution).toEqual({
      unassessed: 1,
      needs_review: 1,
      developing: 1,
      strong: 1,
      due_for_review: 1,
    });
    expect(result.totalConcepts).toBe(5);
    expect(result.assessedConcepts).toBe(4);
    expect(result.assessedCoverage).toBe(0.8);
  });

  it('a mastery row with zero attempts still counts as unassessed (spec H)', () => {
    const result = computeDistribution(
      [concept({ conceptId: 'c-1' })],
      [masteryRecord('c-1', { attemptsCount: 0 })],
      FIXED_NOW
    );
    expect(result.distribution.unassessed).toBe(1);
    expect(result.assessedConcepts).toBe(0);
  });

  it('empty course reports null coverage, never 0/0 math', () => {
    const result = computeDistribution([], [], FIXED_NOW);
    expect(result.assessedCoverage).toBeNull();
    expect(result.totalConcepts).toBe(0);
  });
});
