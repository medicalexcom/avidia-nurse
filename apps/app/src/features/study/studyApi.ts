import type { SupabaseClient } from '@supabase/supabase-js';

import type { CognitiveLevel } from '@avidia/domain';
import type { ConceptSnapshot, MasteryAggregate, UpcomingExam } from '@avidia/mastery';

import type { PracticeQuestionRow } from '../practice/practiceApi';

/**
 * Data plumbing for the M8 study engine (spec AD/AE/AH).
 *
 * Everything read here is the caller's OWN data, enforced database-side:
 * `concept_mastery` and `mastery_events` are select-only (their sole writer
 * is the `submit_question_attempt` RPC), and RLS scopes every table to the
 * caller's courses. The screens never calculate priorities — they pass these
 * rows to the pure `@avidia/mastery` engine (spec AH) — and NOTHING here
 * ever reaches an AI provider: mastery data stays between the student's
 * device and their own database rows (spec AE).
 */

export interface ConceptMasteryRow {
  concept_id: string;
  mastery: number;
  attempts_count: number;
  correct_count: number;
  misconception_severity: number;
  review_stage: number;
  last_attempt_at: string | null;
  next_review_at: string | null;
  algorithm_version: number;
}

export interface CourseAttemptRow {
  question_id: string;
  is_correct: boolean;
  created_at: string;
}

export interface CourseExamRow {
  id: string;
  title: string;
  exam_at: string;
}

/** Minimal concept fields the engine needs (from conceptsApi rows). */
export interface StudyConceptRow {
  id: string;
  canonical_name: string;
  emphasis_score: number;
}

/** The student's own aggregate mastery rows for one course. */
export async function listConceptMastery(
  client: SupabaseClient,
  courseId: string
): Promise<ConceptMasteryRow[]> {
  const { data, error } = await client
    .from('concept_mastery')
    .select(
      'concept_id, mastery, attempts_count, correct_count, misconception_severity, ' +
        'review_stage, last_attempt_at, next_review_at, algorithm_version'
    )
    .eq('course_id', courseId);
  if (error) throw error;
  return (
    (data ?? []) as unknown as (Omit<ConceptMasteryRow, 'mastery'> & {
      mastery: number | string;
      misconception_severity: number | string;
    })[]
  ).map((row) => ({
    ...row,
    mastery: Number(row.mastery),
    misconception_severity: Number(row.misconception_severity),
  }));
}

/** The student's own attempt history for one course (immutable rows). */
export async function listCourseAttempts(
  client: SupabaseClient,
  courseId: string
): Promise<CourseAttemptRow[]> {
  const { data, error } = await client
    .from('question_attempts')
    .select('question_id, is_correct, created_at')
    .eq('course_id', courseId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as CourseAttemptRow[];
}

/** Upcoming and past exams of the course (spec L reads M2 exam dates). */
export async function listCourseExams(
  client: SupabaseClient,
  courseId: string
): Promise<CourseExamRow[]> {
  const { data, error } = await client
    .from('exams')
    .select('id, title, exam_at')
    .eq('course_id', courseId)
    .order('exam_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as CourseExamRow[];
}

/** DB aggregate row → the engine's MasteryAggregate shape. */
export function toAggregate(row: ConceptMasteryRow): MasteryAggregate {
  return {
    mastery: row.mastery,
    attemptsCount: row.attempts_count,
    correctCount: row.correct_count,
    misconceptionSeverity: row.misconception_severity,
    reviewStage: row.review_stage,
    lastAttemptAt: row.last_attempt_at,
    nextReviewAt: row.next_review_at,
  };
}

const HIGHER_ORDER: readonly CognitiveLevel[] = ['application', 'analysis', 'prioritization'];

/**
 * Pure assembly of the engine's inputs from owner-readable rows (testable
 * without a client). Emphasis is normalized against the strongest concept in
 * the course so the priority factor stays bounded (spec N); per-concept
 * attempt facts (last error, higher-order evidence, unseen supply) are
 * derived by joining attempts to question metadata client-side.
 */
export function buildConceptSnapshots(
  concepts: readonly StudyConceptRow[],
  questions: readonly PracticeQuestionRow[],
  masteryRows: readonly ConceptMasteryRow[],
  attempts: readonly CourseAttemptRow[]
): ConceptSnapshot[] {
  const maxEmphasis = Math.max(0, ...concepts.map((c) => c.emphasis_score));
  const masteryByConcept = new Map(masteryRows.map((row) => [row.concept_id, row]));
  const questionById = new Map(questions.map((q) => [q.id, q]));
  const attemptedQuestionIds = new Set(attempts.map((a) => a.question_id));

  const lastIncorrectByConcept = new Map<string, string>();
  const higherOrderCorrect = new Set<string>();
  for (const attempt of attempts) {
    const question = questionById.get(attempt.question_id);
    if (!question || question.concept_id === null) continue;
    if (!attempt.is_correct) {
      const previous = lastIncorrectByConcept.get(question.concept_id);
      if (!previous || attempt.created_at > previous) {
        lastIncorrectByConcept.set(question.concept_id, attempt.created_at);
      }
    } else if (HIGHER_ORDER.includes(question.cognitive_level)) {
      higherOrderCorrect.add(question.concept_id);
    }
  }

  const unseenByConcept = new Map<string, number>();
  for (const question of questions) {
    if (question.concept_id === null) continue;
    if (!attemptedQuestionIds.has(question.id)) {
      unseenByConcept.set(question.concept_id, (unseenByConcept.get(question.concept_id) ?? 0) + 1);
    }
  }

  return concepts.map((concept) => {
    const row = masteryByConcept.get(concept.id);
    return {
      conceptId: concept.id,
      aggregate: row ? toAggregate(row) : null,
      normalizedEmphasis: maxEmphasis > 0 ? concept.emphasis_score / maxEmphasis : 0,
      hasHigherOrderCorrect: higherOrderCorrect.has(concept.id),
      lastIncorrectAt: lastIncorrectByConcept.get(concept.id) ?? null,
      unseenQuestionCount: unseenByConcept.get(concept.id) ?? 0,
    };
  });
}

/** Exam rows → the engine's exam shape (course-wide scope in v1, spec M). */
export function toUpcomingExams(exams: readonly CourseExamRow[]): UpcomingExam[] {
  return exams.map((exam) => ({ examId: exam.id, examAt: exam.exam_at }));
}

/** The set of question ids the student has answered before (spec U repeats). */
export function seenQuestionIds(attempts: readonly CourseAttemptRow[]): Set<string> {
  return new Set(attempts.map((a) => a.question_id));
}
