/**
 * Golden test cases — M8 (spec AL). These pin the END-TO-END behavior a
 * student experiences; if a config change breaks one, that change is a
 * product decision, not a refactor.
 */

import { rankConcepts, scoreConcept, type ConceptSnapshot } from './recommend';
import { masteryState } from './states';
import {
  initialAggregate,
  updateMastery,
  type MasteryAggregate,
  type PerformanceEvent,
} from './update';

const NOW = new Date('2026-08-13T12:00:00.000Z');
const HOUR = 3600_000;

function replay(
  events: Array<Partial<PerformanceEvent>>,
  startIso = '2026-08-12T12:00:00.000Z'
): MasteryAggregate {
  let aggregate = initialAggregate();
  const start = Date.parse(startIso);
  events.forEach((overrides, i) => {
    aggregate = updateMastery(aggregate, {
      isCorrect: true,
      difficulty: 'moderate',
      cognitiveLevel: 'application',
      confidence: null,
      answeredAt: new Date(start + i * HOUR).toISOString(),
      ...overrides,
    }).aggregate;
  });
  return aggregate;
}

function snapshot(
  id: string,
  aggregate: MasteryAggregate | null,
  overrides: Partial<ConceptSnapshot> = {}
): ConceptSnapshot {
  return {
    conceptId: id,
    aggregate,
    normalizedEmphasis: 0.3,
    hasHigherOrderCorrect: false,
    lastIncorrectAt: null,
    unseenQuestionCount: 10,
    ...overrides,
  };
}

describe('golden cases (spec AL)', () => {
  it('1. a brand-new concept with no attempts is NEW/unassessed', () => {
    expect(masteryState(null, NOW)).toBe('unassessed');
    const rec = scoreConcept(snapshot('c1', null), [], 'America/Chicago', NOW);
    expect(rec.masteryState).toBe('unassessed');
    expect(rec.reasonCodes).toContain('unassessed');
  });

  it('2. three correct moderate application-level answers reach DEVELOPING or better', () => {
    const aggregate = replay([
      { confidence: 'pretty_sure' },
      { confidence: 'pretty_sure' },
      { confidence: 'pretty_sure' },
    ]);
    const state = masteryState(aggregate, new Date(Date.parse(aggregate.lastAttemptAt!) + HOUR));
    expect(['developing', 'strong']).toContain(state);
    expect(aggregate.mastery).toBeGreaterThanOrEqual(0.4);
  });

  it('3. repeated incorrect answers land in NEEDS REVIEW', () => {
    const aggregate = replay([
      { isCorrect: false, confidence: 'unsure' },
      { isCorrect: false, confidence: 'unsure' },
      { isCorrect: false, confidence: 'pretty_sure' },
      { isCorrect: false, confidence: 'unsure' },
    ]);
    expect(masteryState(aggregate, new Date(Date.parse(aggregate.lastAttemptAt!) + HOUR))).toBe(
      'needs_review'
    );
  });

  it('4. previously strong but past the review window shows DUE FOR REVIEW', () => {
    const aggregate = replay(
      Array.from({ length: 10 }, () => ({ confidence: 'certain' as const })),
      '2026-06-01T12:00:00.000Z'
    );
    expect(aggregate.mastery).toBeGreaterThanOrEqual(0.75);
    expect(masteryState(aggregate, NOW)).toBe('due_for_review'); // ~2 months later
  });

  it('5. a weak concept with an exam tomorrow gets the highest study priority', () => {
    const weak = replay([
      { isCorrect: false, confidence: 'unsure' },
      { isCorrect: false, confidence: 'certain' },
      { isCorrect: false, confidence: 'unsure' },
    ]);
    const strong = replay(Array.from({ length: 8 }, () => ({ confidence: 'certain' as const })));
    const ranked = rankConcepts({
      concepts: [
        snapshot('strong-concept', strong),
        snapshot('weak-exam-concept', weak, { lastIncorrectAt: weak.lastAttemptAt }),
        snapshot('unassessed-concept', null),
      ],
      exams: [{ examId: 'e1', examAt: '2026-08-14T14:00:00.000Z' }],
      timeZone: 'America/Chicago',
      now: NOW,
    });
    expect(ranked[0]!.conceptId).toBe('weak-exam-concept');
    expect(ranked[0]!.reasonCodes).toEqual(
      expect.arrayContaining(['low_mastery', 'exam_soon', 'recent_error'])
    );
  });
});
