import {
  buildConceptSnapshots,
  seenQuestionIds,
  toAggregate,
  toUpcomingExams,
  type ConceptMasteryRow,
  type CourseAttemptRow,
  type StudyConceptRow,
} from './studyApi';
import type { PracticeQuestionRow } from '../practice/practiceApi';

/**
 * Pure assembly tests (M8 spec AH): the screens hand these outputs to the
 * pure @avidia/mastery engine, so the joins here must be exactly right.
 */

const concepts: StudyConceptRow[] = [
  { id: 'c1', canonical_name: 'Hyperkalemia management', emphasis_score: 8 },
  { id: 'c2', canonical_name: 'Insulin administration', emphasis_score: 4 },
  { id: 'c3', canonical_name: 'Fall precautions', emphasis_score: 0 },
];

function question(
  id: string,
  conceptId: string | null,
  cognitiveLevel: PracticeQuestionRow['cognitive_level'] = 'recall'
): PracticeQuestionRow {
  return {
    id,
    course_id: 'course-1',
    concept_id: conceptId,
    question_type: 'single_best_answer',
    stem: 'stem',
    difficulty: 'moderate',
    cognitive_level: cognitiveLevel,
    source_type: 'course_grounded',
    priority_frameworks: [],
    options: [],
  };
}

const questions = [
  question('q1', 'c1', 'analysis'),
  question('q2', 'c1'),
  question('q3', 'c2'),
  question('q4', null),
];

const masteryRow: ConceptMasteryRow = {
  concept_id: 'c1',
  mastery: 0.62,
  attempts_count: 5,
  correct_count: 3,
  misconception_severity: 0.2,
  review_stage: 1,
  last_attempt_at: '2026-08-10T12:00:00.000Z',
  next_review_at: '2026-08-13T12:00:00.000Z',
  algorithm_version: 1,
};

const attempts: CourseAttemptRow[] = [
  { question_id: 'q1', is_correct: true, created_at: '2026-08-09T12:00:00.000Z' },
  { question_id: 'q2', is_correct: false, created_at: '2026-08-10T12:00:00.000Z' },
];

describe('buildConceptSnapshots (spec AH)', () => {
  const snapshots = buildConceptSnapshots(concepts, questions, [masteryRow], attempts);
  const byId = new Map(snapshots.map((s) => [s.conceptId, s]));

  it('produces one snapshot per concept, joining mastery where present', () => {
    expect(snapshots).toHaveLength(3);
    expect(byId.get('c1')!.aggregate).toEqual(toAggregate(masteryRow));
    expect(byId.get('c2')!.aggregate).toBeNull();
    expect(byId.get('c3')!.aggregate).toBeNull();
  });

  it('normalizes emphasis against the strongest concept (spec N)', () => {
    expect(byId.get('c1')!.normalizedEmphasis).toBe(1);
    expect(byId.get('c2')!.normalizedEmphasis).toBe(0.5);
    expect(byId.get('c3')!.normalizedEmphasis).toBe(0);
  });

  it('derives last-incorrect and higher-order evidence from the join', () => {
    // q2 (c1) was incorrect; q1 (c1) was a correct analysis-level answer.
    expect(byId.get('c1')!.lastIncorrectAt).toBe('2026-08-10T12:00:00.000Z');
    expect(byId.get('c1')!.hasHigherOrderCorrect).toBe(true);
    expect(byId.get('c2')!.lastIncorrectAt).toBeNull();
    expect(byId.get('c2')!.hasHigherOrderCorrect).toBe(false);
  });

  it('counts unseen questions per concept (spec U/Y)', () => {
    expect(byId.get('c1')!.unseenQuestionCount).toBe(0); // q1+q2 both attempted
    expect(byId.get('c2')!.unseenQuestionCount).toBe(1); // q3 never attempted
    expect(byId.get('c3')!.unseenQuestionCount).toBe(0); // no questions at all
  });

  it('handles the all-zero emphasis course without dividing by zero', () => {
    const zeroed = concepts.map((c) => ({ ...c, emphasis_score: 0 }));
    const result = buildConceptSnapshots(zeroed, [], [], []);
    for (const snapshot of result) expect(snapshot.normalizedEmphasis).toBe(0);
  });
});

describe('row adapters', () => {
  it('toAggregate maps DB columns to the engine shape', () => {
    expect(toAggregate(masteryRow)).toEqual({
      mastery: 0.62,
      attemptsCount: 5,
      correctCount: 3,
      misconceptionSeverity: 0.2,
      reviewStage: 1,
      lastAttemptAt: '2026-08-10T12:00:00.000Z',
      nextReviewAt: '2026-08-13T12:00:00.000Z',
    });
  });

  it('toUpcomingExams keeps id and time only (course-wide scope, spec M)', () => {
    expect(
      toUpcomingExams([{ id: 'e1', title: 'Final', exam_at: '2026-09-01T14:00:00.000Z' }])
    ).toEqual([{ examId: 'e1', examAt: '2026-09-01T14:00:00.000Z' }]);
  });

  it('seenQuestionIds collects the distinct attempted question ids (spec U)', () => {
    expect(seenQuestionIds(attempts)).toEqual(new Set(['q1', 'q2']));
  });
});
