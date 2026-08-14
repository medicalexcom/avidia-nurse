/**
 * M9 spec AF — pure session-plan helpers: composition per duration, resume
 * subtraction, deterministic adaptation, server-echo folding, and the honest
 * completion summary.
 */

import type { StudyRecommendation, SelectableQuestion } from '@avidia/mastery';

import type { MasteryEcho, SessionPlanRow } from '../practice/practiceApi';
import type { ConceptMasteryRow } from '../study/studyApi';
import {
  MISCONCEPTION_REVISIT_MESSAGE,
  appendLocalAttempt,
  applyMasteryEcho,
  buildSessionSummary,
  dueReviewConceptIds,
  estimateRemainingMinutes,
  hasActiveMisconceptionFactor,
  questionCountForDuration,
  remainingPlanQuestionIds,
  reorderRemainingQuestions,
} from './plan';

function rec(conceptId: string, priority: number, misconception = 1): StudyRecommendation {
  return {
    conceptId,
    priority,
    factors: {
      examRelevance: 1,
      weakness: 1,
      forgettingRisk: 0.6,
      emphasisFactor: 1,
      misconceptionMultiplier: misconception,
      transferNeed: 1,
    },
    masteryState: 'developing',
    reasonCodes: ['low_mastery'],
    recommendedQuestionCharacteristics: {
      difficulties: ['easy', 'moderate'],
      cognitiveLevels: ['recall', 'application'],
    },
    nextReviewAt: null,
    urgentExamId: null,
  };
}

function selectable(id: string, conceptId: string | null, seen = false): SelectableQuestion {
  return { questionId: id, conceptId, difficulty: 'moderate', cognitiveLevel: 'recall', seen };
}

function masteryRow(
  conceptId: string,
  overrides: Partial<ConceptMasteryRow> = {}
): ConceptMasteryRow {
  return {
    concept_id: conceptId,
    mastery: 0.5,
    attempts_count: 4,
    correct_count: 2,
    misconception_severity: 0,
    review_stage: 1,
    last_attempt_at: '2026-08-10T10:00:00.000Z',
    next_review_at: '2026-08-13T10:00:00.000Z',
    algorithm_version: 1,
    ...overrides,
  };
}

describe('questionCountForDuration (spec B/D)', () => {
  it('maps each duration preset to a proportional count', () => {
    expect(questionCountForDuration(5, 100)).toBe(4);
    expect(questionCountForDuration(10, 100)).toBe(8);
    expect(questionCountForDuration(20, 100)).toBe(16);
    expect(questionCountForDuration(45, 100)).toBe(36);
  });

  it('never plans below the minimum when supply allows', () => {
    expect(questionCountForDuration(1, 100)).toBe(3);
  });

  it('never exceeds the database maximum of 50', () => {
    expect(questionCountForDuration(500, 1000)).toBe(50);
  });

  it('shrinks to the available pool instead of blocking (spec W/X)', () => {
    expect(questionCountForDuration(20, 5)).toBe(5);
    expect(questionCountForDuration(45, 2)).toBe(2);
  });

  it('returns zero for an empty pool so callers show an empty state', () => {
    expect(questionCountForDuration(10, 0)).toBe(0);
  });
});

describe('estimateRemainingMinutes (spec I)', () => {
  it('estimates from the per-question planning constant', () => {
    expect(estimateRemainingMinutes(8)).toBe(10);
    expect(estimateRemainingMinutes(4)).toBe(5);
  });

  it('never shows zero while questions remain', () => {
    expect(estimateRemainingMinutes(1)).toBe(1);
  });

  it('is zero when nothing remains', () => {
    expect(estimateRemainingMinutes(0)).toBe(0);
  });
});

describe('remainingPlanQuestionIds (spec O/AB)', () => {
  const plan: SessionPlanRow[] = [
    { position: 1, question_id: 'q1', skipped_at: null },
    { position: 2, question_id: 'q2', skipped_at: '2026-08-13T09:00:00.000Z' },
    { position: 3, question_id: 'q3', skipped_at: null },
    { position: 4, question_id: 'q4', skipped_at: null },
  ];

  it('subtracts answered and skipped questions, preserving plan order', () => {
    expect(remainingPlanQuestionIds(plan, new Set(['q3']))).toEqual(['q1', 'q4']);
  });

  it('returns the full unskipped plan when nothing is answered', () => {
    expect(remainingPlanQuestionIds(plan, new Set())).toEqual(['q1', 'q3', 'q4']);
  });

  it('returns empty once everything is answered or skipped', () => {
    expect(remainingPlanQuestionIds(plan, new Set(['q1', 'q3', 'q4']))).toEqual([]);
  });
});

describe('reorderRemainingQuestions (spec J/AB)', () => {
  const remaining = [
    selectable('q1', 'c-low'),
    selectable('q2', 'c-high'),
    selectable('q3', 'c-high'),
    selectable('q4', 'c-low'),
  ];

  it('is deterministic for identical inputs', () => {
    const ranked = [rec('c-high', 3), rec('c-low', 1)];
    const a = reorderRemainingQuestions(remaining, ranked, 'session-1', 2);
    const b = reorderRemainingQuestions(remaining, ranked, 'session-1', 2);
    expect(a).toEqual(b);
  });

  it('changes seed (and possibly order) as the session progresses', () => {
    const ranked = [rec('c-high', 3), rec('c-low', 1)];
    // Different progress points may produce different orders, but always the
    // same SET of remaining questions — nothing is lost or invented.
    const a = reorderRemainingQuestions(remaining, ranked, 'session-1', 0);
    const b = reorderRemainingQuestions(remaining, ranked, 'session-1', 3);
    expect([...a].sort()).toEqual(['q1', 'q2', 'q3', 'q4']);
    expect([...b].sort()).toEqual(['q1', 'q2', 'q3', 'q4']);
  });

  it('puts the highest-priority concept first', () => {
    const ranked = [rec('c-high', 5), rec('c-low', 0.5)];
    const order = reorderRemainingQuestions(remaining, ranked, 'seed', 0);
    const first = remaining.find((q) => q.questionId === order[0]);
    expect(first?.conceptId).toBe('c-high');
  });

  it('returns every remaining question exactly once', () => {
    const ranked = [rec('c-high', 3)];
    const order = reorderRemainingQuestions(remaining, ranked, 's', 1);
    expect(order).toHaveLength(4);
    expect(new Set(order).size).toBe(4);
  });
});

describe('applyMasteryEcho (spec C — server numbers only)', () => {
  const echo: MasteryEcho = {
    concept_id: 'c1',
    mastery: 0.448,
    mastery_delta: 0.198,
    attempts_count: 5,
    correct_count: 3,
    misconception_severity: 0.1,
    review_stage: 2,
    next_review_at: '2026-08-20T10:00:00.000Z',
    algorithm_version: 1,
  };

  it('replaces the existing row with the server aggregate', () => {
    const rows = [masteryRow('c1'), masteryRow('c2')];
    const next = applyMasteryEcho(rows, echo, '2026-08-13T12:00:00.000Z');
    expect(next).toHaveLength(2);
    const updated = next.find((row) => row.concept_id === 'c1');
    expect(updated?.mastery).toBe(0.448);
    expect(updated?.attempts_count).toBe(5);
    expect(updated?.last_attempt_at).toBe('2026-08-13T12:00:00.000Z');
    expect(next.find((row) => row.concept_id === 'c2')).toEqual(masteryRow('c2'));
  });

  it('inserts a row for a first-evidence concept', () => {
    const next = applyMasteryEcho([masteryRow('c2')], echo, '2026-08-13T12:00:00.000Z');
    expect(next.map((row) => row.concept_id).sort()).toEqual(['c1', 'c2']);
  });
});

describe('appendLocalAttempt', () => {
  it('appends without mutating the original list', () => {
    const original = [{ question_id: 'q1', is_correct: true, created_at: 't1' }];
    const next = appendLocalAttempt(original, 'q2', false, 't2');
    expect(original).toHaveLength(1);
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ question_id: 'q2', is_correct: false, created_at: 't2' });
  });
});

describe('misconception remediation copy (spec L)', () => {
  it('activates from the priority factors, not any local calculation', () => {
    expect(hasActiveMisconceptionFactor(rec('c1', 2, 1.5))).toBe(true);
    expect(hasActiveMisconceptionFactor(rec('c1', 2, 1))).toBe(false);
    expect(hasActiveMisconceptionFactor(undefined)).toBe(false);
  });

  it('uses respectful, non-alarming language', () => {
    const lower = MISCONCEPTION_REVISIT_MESSAGE.toLowerCase();
    for (const banned of ['dangerous', 'misconception', 'wrong', 'fail', 'bad']) {
      expect(lower).not.toContain(banned);
    }
    expect(lower).toContain('different angle');
  });
});

describe('buildSessionSummary (spec M)', () => {
  const records = [
    { questionId: 'q1', conceptId: 'c1', isCorrect: true, masteryDelta: 0.2 },
    { questionId: 'q2', conceptId: 'c1', isCorrect: false, masteryDelta: -0.05 },
    { questionId: 'q3', conceptId: 'c2', isCorrect: false, masteryDelta: -0.1 },
    { questionId: 'q4', conceptId: null, isCorrect: true, masteryDelta: null },
  ];

  it('reports honest counts and unique concepts', () => {
    const summary = buildSessionSummary({
      records,
      skippedCount: 1,
      dueConceptIdsAtStart: new Set(['c2']),
      latestRanked: [rec('c3', 4), rec('c2', 3), rec('c1', 1)],
    });
    expect(summary.answeredCount).toBe(4);
    expect(summary.correctCount).toBe(2);
    expect(summary.skippedCount).toBe(1);
    expect(summary.conceptsReviewed).toEqual(['c1', 'c2']);
    // c1 net +0.15 improved; c2 net -0.1 not improved — server deltas only.
    expect(summary.conceptsImproved).toEqual(['c1']);
    expect(summary.dueReviewsCompleted).toBe(1);
  });

  it('lists remaining priorities excluding concepts already touched', () => {
    const summary = buildSessionSummary({
      records,
      skippedCount: 0,
      dueConceptIdsAtStart: new Set(),
      latestRanked: [rec('c3', 4), rec('c2', 3), rec('c4', 2), rec('c5', 1.5), rec('c6', 1)],
    });
    expect(summary.remainingPriorities.map((r) => r.conceptId)).toEqual(['c3', 'c4', 'c5']);
    expect(summary.recommendedNext?.conceptId).toBe('c3');
  });

  it('handles an early stop with few records (spec D)', () => {
    const summary = buildSessionSummary({
      records: records.slice(0, 1),
      skippedCount: 0,
      dueConceptIdsAtStart: new Set(),
      latestRanked: [],
    });
    expect(summary.answeredCount).toBe(1);
    expect(summary.recommendedNext).toBeNull();
    expect(summary.remainingPriorities).toEqual([]);
  });
});

describe('dueReviewConceptIds (spec R — reads the M8 schedule)', () => {
  it('collects concepts whose next review is due or overdue', () => {
    const now = new Date('2026-08-13T12:00:00.000Z');
    const rows = [
      masteryRow('c-due', { next_review_at: '2026-08-13T10:00:00.000Z' }),
      masteryRow('c-later', { next_review_at: '2026-08-14T10:00:00.000Z' }),
      masteryRow('c-none', { next_review_at: null }),
    ];
    expect([...dueReviewConceptIds(rows, now)]).toEqual(['c-due']);
  });
});
