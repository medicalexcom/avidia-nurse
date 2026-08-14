import {
  getStudyRecommendation,
  rankConcepts,
  scoreConcept,
  targetCharacteristics,
  type ConceptSnapshot,
  type RecommendationInput,
} from './recommend';
import { initialAggregate, type MasteryAggregate } from './update';
import type { UpcomingExam } from './examUrgency';

const NOW = new Date('2026-08-13T12:00:00.000Z');
const TZ = 'America/Chicago';

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

function concept(id: string, overrides: Partial<ConceptSnapshot> = {}): ConceptSnapshot {
  return {
    conceptId: id,
    aggregate: assessed(),
    normalizedEmphasis: 0.3,
    hasHigherOrderCorrect: true,
    lastIncorrectAt: null,
    unseenQuestionCount: 10,
    ...overrides,
  };
}

function reqInput(concepts: ConceptSnapshot[], exams: UpcomingExam[] = []): RecommendationInput {
  return { concepts, exams, timeZone: TZ, now: NOW };
}

describe('scoreConcept reason codes (spec S/T)', () => {
  it('unassessed concepts carry the UNASSESSED reason', () => {
    const rec = scoreConcept(concept('c1', { aggregate: null }), [], TZ, NOW);
    expect(rec.masteryState).toBe('unassessed');
    expect(rec.reasonCodes).toContain('unassessed');
    expect(rec.reasonCodes).not.toContain('low_mastery');
  });

  it('low mastery carries LOW_MASTERY', () => {
    const rec = scoreConcept(concept('c1', { aggregate: assessed({ mastery: 0.2 }) }), [], TZ, NOW);
    expect(rec.reasonCodes).toContain('low_mastery');
  });

  it('overdue review carries REVIEW_DUE', () => {
    const rec = scoreConcept(
      concept('c1', { aggregate: assessed({ nextReviewAt: '2026-08-13T00:00:00.000Z' }) }),
      [],
      TZ,
      NOW
    );
    expect(rec.masteryState).toBe('due_for_review');
    expect(rec.reasonCodes).toContain('review_due');
  });

  it('a recent incorrect within the window carries RECENT_ERROR', () => {
    const recent = scoreConcept(
      concept('c1', { lastIncorrectAt: '2026-08-12T12:00:00.000Z' }),
      [],
      TZ,
      NOW
    );
    expect(recent.reasonCodes).toContain('recent_error');
    const stale = scoreConcept(
      concept('c1', { lastIncorrectAt: '2026-08-01T12:00:00.000Z' }),
      [],
      TZ,
      NOW
    );
    expect(stale.reasonCodes).not.toContain('recent_error');
  });

  it('an upcoming exam carries EXAM_SOON with the exam id', () => {
    const rec = scoreConcept(
      concept('c1'),
      [{ examId: 'e1', examAt: '2026-08-14T14:00:00.000Z' }],
      TZ,
      NOW
    );
    expect(rec.reasonCodes).toContain('exam_soon');
    expect(rec.urgentExamId).toBe('e1');
  });

  it('high emphasis carries HIGH_COURSE_EMPHASIS (spec N)', () => {
    const rec = scoreConcept(concept('c1', { normalizedEmphasis: 0.9 }), [], TZ, NOW);
    expect(rec.reasonCodes).toContain('high_course_emphasis');
  });

  it('a thin question bank carries QUESTION_SUPPLY_LOW (spec Y)', () => {
    const rec = scoreConcept(concept('c1', { unseenQuestionCount: 1 }), [], TZ, NOW);
    expect(rec.reasonCodes).toContain('question_supply_low');
  });
});

describe('targetCharacteristics (spec U/X)', () => {
  it('unassessed and low mastery get foundational targets', () => {
    expect(targetCharacteristics(null).difficulties).toEqual(['easy', 'moderate']);
    expect(targetCharacteristics(assessed({ mastery: 0.1 })).cognitiveLevels).toContain('recall');
  });

  it('strong mastery targets higher-order levels', () => {
    const strong = targetCharacteristics(assessed({ mastery: 0.9 }));
    expect(strong.cognitiveLevels).toContain('prioritization');
    expect(strong.difficulties).toContain('hard');
  });
});

describe('ranking and recommendation (spec S/AB/AH/AK G)', () => {
  it('a weak exam-relevant concept outranks a weak concept off the exam (spec AK G)', () => {
    const exams: UpcomingExam[] = [
      { examId: 'e1', examAt: '2026-08-14T14:00:00.000Z', conceptIds: ['on-exam'] },
    ];
    const ranked = rankConcepts(
      reqInput(
        [
          concept('off-exam', { aggregate: assessed({ mastery: 0.2 }) }),
          concept('on-exam', { aggregate: assessed({ mastery: 0.2 }) }),
        ],
        exams
      )
    );
    expect(ranked[0]!.conceptId).toBe('on-exam');
  });

  it('a strong-but-overdue concept has review urgency without losing its evidence (spec AK E)', () => {
    const overdue = concept('overdue-strong', {
      aggregate: assessed({
        mastery: 0.9,
        lastAttemptAt: '2026-07-14T12:00:00.000Z',
        nextReviewAt: '2026-08-13T00:00:00.000Z',
      }),
    });
    const fresh = concept('fresh-strong', { aggregate: assessed({ mastery: 0.9 }) });
    const ranked = rankConcepts(reqInput([fresh, overdue]));
    expect(ranked[0]!.conceptId).toBe('overdue-strong');
    expect(ranked[0]!.masteryState).toBe('due_for_review');
  });

  it('breaks priority ties deterministically by concept id (spec AB)', () => {
    const a = rankConcepts(reqInput([concept('b'), concept('a')]));
    const b = rankConcepts(reqInput([concept('a'), concept('b')]));
    expect(a.map((r) => r.conceptId)).toEqual(b.map((r) => r.conceptId));
    expect(a[0]!.conceptId).toBe('a');
  });

  it('getStudyRecommendation returns the top concept or null (spec AH/AN)', () => {
    expect(getStudyRecommendation(reqInput([]))).toBeNull();
    const rec = getStudyRecommendation(
      reqInput([concept('c1', { aggregate: assessed({ mastery: 0.1 }) }), concept('c2')])
    );
    expect(rec?.conceptId).toBe('c1');
    expect(rec?.reasonCodes.length).toBeGreaterThan(0);
    expect(rec?.recommendedQuestionCharacteristics.difficulties.length).toBeGreaterThan(0);
  });

  it('never emits numeric mastery in states — the UI gets coarse labels (spec AG)', () => {
    const rec = getStudyRecommendation(reqInput([concept('c1')]));
    expect(['unassessed', 'needs_review', 'developing', 'strong', 'due_for_review']).toContain(
      rec!.masteryState
    );
  });
});
