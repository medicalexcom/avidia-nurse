import { computeExamReadiness, nextUpcomingExam } from './readiness';
import {
  FIXED_NOW,
  TZ,
  attempt,
  concept,
  daysAgo,
  exam,
  masteryRecord,
  resetFixtureIds,
} from './fixtures';

beforeEach(resetFixtureIds);

const tenConcepts = () =>
  Array.from({ length: 10 }, (_, i) => concept({ conceptId: `c-${i + 1}` }));

describe('exam readiness (spec N/O/P/Q/R/S)', () => {
  it('no evidence → early, with the honest reason (student E)', () => {
    const result = computeExamReadiness(tenConcepts(), [], [], [exam()], FIXED_NOW, TZ);
    expect(result.state).toBe('early');
    expect(result.reasons).toContain('no_evidence_yet');
    expect(result.exam).not.toBeNull();
    expect(result.daysUntilExam).toBe(14);
  });

  it('high accuracy on 30% coverage is capped at building (student B, spec O/Q)', () => {
    const mastery = [1, 2, 3].map((i) =>
      masteryRecord(`c-${i}`, {
        mastery: 0.9,
        attemptsCount: 8,
        correctCount: 7,
        nextReviewAt: daysAgo(-10),
      })
    );
    const attempts = Array.from({ length: 24 }, (_, i) =>
      attempt({ conceptId: `c-${(i % 3) + 1}`, isCorrect: true, createdAt: daysAgo(i % 10) })
    );
    const result = computeExamReadiness(tenConcepts(), mastery, attempts, [exam()], FIXED_NOW, TZ);
    expect(result.state).toBe('building');
    expect(result.reasons).toContain('low_coverage');
    expect(result.reasons).toContain('strong_share_solid'); // honest: the slice IS strong
    expect(result.assessedCoverage).toBeCloseTo(0.3);
    expect(result.strongShareOfAssessed).toBe(1);
  });

  it('broad coverage + consistent strength → strong', () => {
    const mastery = Array.from({ length: 9 }, (_, i) =>
      masteryRecord(`c-${i + 1}`, {
        mastery: i < 7 ? 0.9 : 0.6,
        attemptsCount: 6,
        correctCount: 5,
        nextReviewAt: daysAgo(-10),
      })
    );
    const attempts = Array.from({ length: 40 }, (_, i) =>
      attempt({ conceptId: `c-${(i % 9) + 1}`, isCorrect: i % 5 !== 0, createdAt: daysAgo(i % 12) })
    );
    const result = computeExamReadiness(tenConcepts(), mastery, attempts, [exam()], FIXED_NOW, TZ);
    expect(result.state).toBe('strong');
    expect(result.reasons).toEqual(
      expect.arrayContaining(['broad_coverage', 'consistent_strength'])
    );
  });

  it('sparse evidence forces low-confidence wording (spec P)', () => {
    const mastery = Array.from({ length: 8 }, (_, i) =>
      masteryRecord(`c-${i + 1}`, {
        mastery: 0.9,
        attemptsCount: 1,
        correctCount: 1,
        nextReviewAt: daysAgo(-10),
      })
    );
    const attempts = Array.from({ length: 8 }, (_, i) =>
      attempt({ conceptId: `c-${i + 1}`, isCorrect: true, createdAt: daysAgo(i) })
    );
    const result = computeExamReadiness(tenConcepts(), mastery, attempts, [exam()], FIXED_NOW, TZ);
    expect(result.lowConfidence).toBe(true);
    expect(result.state).toBe('building');
    expect(result.reasons).toContain('sparse_evidence');
  });

  it('never emits a grade or percentage prediction (spec R)', () => {
    const result = computeExamReadiness(tenConcepts(), [], [], [exam()], FIXED_NOW, TZ);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/grade|score|percent|%|guarantee/i);
  });

  it('exam focus comes from the M8 engine with reason codes (spec S)', () => {
    const mastery = [
      masteryRecord('c-1', {
        mastery: 0.1,
        attemptsCount: 5,
        correctCount: 1,
        nextReviewAt: daysAgo(1),
      }),
      masteryRecord('c-2', {
        mastery: 0.9,
        attemptsCount: 6,
        correctCount: 6,
        nextReviewAt: daysAgo(-10),
      }),
    ];
    const attempts = Array.from({ length: 25 }, (_, i) =>
      attempt({
        conceptId: i % 2 === 0 ? 'c-1' : 'c-2',
        isCorrect: i % 2 !== 0,
        createdAt: daysAgo(i % 6),
      })
    );
    const result = computeExamReadiness(tenConcepts(), mastery, attempts, [exam()], FIXED_NOW, TZ);
    expect(result.focus.length).toBeGreaterThan(0);
    expect(result.focus.length).toBeLessThanOrEqual(3);
    // The weak, overdue concept must outrank the strong one.
    const ids = result.focus.map((f) => f.conceptId);
    expect(ids.indexOf('c-1')).toBeGreaterThanOrEqual(0);
    expect(result.focus[0]!.reasonCodes.length).toBeGreaterThan(0);
  });

  it('picks the next upcoming exam deterministically', () => {
    const past = exam({ examId: 'e-past', examAt: daysAgo(3) });
    const near = exam({ examId: 'e-near', examAt: daysAgo(-7) });
    const far = exam({ examId: 'e-far', examAt: daysAgo(-30) });
    expect(nextUpcomingExam([far, past, near], FIXED_NOW, TZ)?.examId).toBe('e-near');
    expect(nextUpcomingExam([past], FIXED_NOW, TZ)).toBeNull();
  });
});
