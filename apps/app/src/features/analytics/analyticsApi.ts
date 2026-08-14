/**
 * Analytics data plumbing — M12 (spec A/B/AK/AM).
 *
 * Every fetch here reads the caller's OWN rows through the existing RLS
 * policies (spec AO) — analytics introduces no new write path and no new
 * table. Fetches are BOUNDED (spec AK): the attempt history is capped at the
 * most recent window that the analytics engine actually uses, so a heavy
 * course never ships its lifetime history to the client. Simulation
 * aggregates come from the compact `get_simulation_analytics` RPC (migration
 * 0013) because score/state/definition are server-only columns.
 *
 * Nothing fetched here ever reaches an AI provider or third-party analytics
 * (spec AM): rows go straight into the pure `@avidia/analytics` engine and
 * are rendered locally.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { CognitiveLevel, ConfidenceLevel, QuestionDifficulty } from '@avidia/domain';
import type {
  AnalyticsInput,
  AttemptRecord,
  ConceptRecord,
  ExamRecord,
  SessionRecord,
  SimulationDimensionRecord,
  SimulationRecord,
} from '@avidia/analytics';
// Deep import (same convention as simulationApi): the simulation barrel also
// exports the validator, which pulls node-only modules the web bundle must
// not see.
import { CJMM_DIMENSIONS, CJMM_LABELS, type CjmmDimension } from '@avidia/simulation/src/types';

import { listConcepts } from '../concepts/conceptsApi';
import { listConceptMastery, listCourseExams, toAggregate } from '../study/studyApi';

/**
 * Bound on the attempt history fetched for analytics (spec AK). 2,000 recent
 * attempts comfortably covers the 30-day windows plus per-concept recency —
 * and the engine's course-to-date numbers that need FULL history (coverage,
 * distribution) come from `concept_mastery` aggregates, not from this list.
 */
export const ATTEMPT_FETCH_LIMIT = 2000;

/** Bound on the session list (streak/consistency only need recent rows). */
export const SESSION_FETCH_LIMIT = 500;

interface AttemptQueryRow {
  id: string;
  question_id: string;
  is_correct: boolean;
  confidence: ConfidenceLevel | null;
  created_at: string;
  questions: {
    concept_id: string | null;
    difficulty: QuestionDifficulty;
    cognitive_level: CognitiveLevel;
    question_type: string;
  } | null;
  study_sessions: { session_type: string } | null;
}

/**
 * The most recent attempts of a course joined with the question metadata the
 * engine slices by (concept, difficulty, cognitive level, type) and the
 * owning session's type. Returned oldest-first for deterministic processing.
 */
export async function listAnalyticsAttempts(
  client: SupabaseClient,
  courseId: string
): Promise<AttemptRecord[]> {
  const { data, error } = await client
    .from('question_attempts')
    .select(
      'id, question_id, is_correct, confidence, created_at, ' +
        'questions(concept_id, difficulty, cognitive_level, question_type), ' +
        'study_sessions(session_type)'
    )
    .eq('course_id', courseId)
    .order('created_at', { ascending: false })
    .limit(ATTEMPT_FETCH_LIMIT);
  if (error) throw error;
  return ((data ?? []) as unknown as AttemptQueryRow[])
    .map((row) => ({
      attemptId: row.id,
      questionId: row.question_id,
      conceptId: row.questions?.concept_id ?? null,
      isCorrect: row.is_correct,
      confidence: row.confidence,
      difficulty: row.questions?.difficulty ?? 'moderate',
      cognitiveLevel: row.questions?.cognitive_level ?? 'recall',
      questionType: row.questions?.question_type ?? 'sba',
      sessionType: row.study_sessions?.session_type ?? null,
      createdAt: row.created_at,
    }))
    .reverse();
}

interface SessionQueryRow {
  id: string;
  session_type: string;
  status: 'in_progress' | 'completed' | 'abandoned';
  started_at: string;
  completed_at: string | null;
  question_attempts: { count: number }[];
}

/** Recent study sessions with their attempt counts (consistency + modes). */
export async function listAnalyticsSessions(
  client: SupabaseClient,
  courseId: string
): Promise<SessionRecord[]> {
  const { data, error } = await client
    .from('study_sessions')
    .select('id, session_type, status, started_at, completed_at, question_attempts(count)')
    .eq('course_id', courseId)
    .order('started_at', { ascending: false })
    .limit(SESSION_FETCH_LIMIT);
  if (error) throw error;
  return ((data ?? []) as unknown as SessionQueryRow[]).map((row) => ({
    sessionId: row.id,
    sessionType: row.session_type,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    attemptCount: row.question_attempts?.[0]?.count ?? 0,
  }));
}

interface SimulationAnalyticsRpcSession {
  sessionId: string;
  caseKey: string;
  caseTitle: string;
  outcomeId: string;
  outcomeKind: string;
  outcomeLabel: string;
  completedAt: string;
  durationMinutes: number | null;
  earned: number | null;
  possible: number | null;
  dimensions: Record<string, { earned: number; possible: number }> | null;
  criticalMissedCount: number;
  unsafeActionCount: number;
}

const OUTCOME_KINDS = ['stabilized', 'deteriorated', 'complication', 'timeout'] as const;

function toOutcomeKind(value: string): SimulationRecord['outcomeKind'] {
  return (OUTCOME_KINDS as readonly string[]).includes(value)
    ? (value as SimulationRecord['outcomeKind'])
    : 'timeout';
}

function toDimensionRecords(
  dimensions: Record<string, { earned: number; possible: number }> | null
): SimulationDimensionRecord[] {
  if (!dimensions) return [];
  return CJMM_DIMENSIONS.filter((d): d is CjmmDimension => d in dimensions).map((d) => ({
    dimension: d,
    label: CJMM_LABELS[d],
    earned: Number(dimensions[d]?.earned ?? 0),
    possible: Number(dimensions[d]?.possible ?? 0),
  }));
}

/**
 * Compact per-completed-session simulation aggregates for the course (spec
 * Z/AK) via the read-only RPC — counts and points only, never hidden case
 * internals.
 */
export async function fetchSimulationAnalytics(
  client: SupabaseClient,
  courseId: string
): Promise<SimulationRecord[]> {
  const { data, error } = await client.rpc('get_simulation_analytics', {
    p_course_id: courseId,
  });
  if (error) throw error;
  const sessions = (data as { sessions?: SimulationAnalyticsRpcSession[] })?.sessions ?? [];
  return sessions.map((s) => ({
    sessionId: s.sessionId,
    caseKey: s.caseKey,
    caseTitle: s.caseTitle,
    outcomeKind: toOutcomeKind(s.outcomeKind),
    outcomeLabel: s.outcomeLabel,
    completedAt: s.completedAt,
    earned: Number(s.earned ?? 0),
    possible: Number(s.possible ?? 0),
    criticalMissedCount: Number(s.criticalMissedCount ?? 0),
    unsafeActionCount: Number(s.unsafeActionCount ?? 0),
    dimensions: toDimensionRecords(s.dimensions),
  }));
}

/**
 * One-stop assembly of the engine's input bundle (spec A): six bounded,
 * owner-scoped reads in parallel, reusing the existing M6/M8 fetchers so
 * analytics can never disagree with the surfaces it summarizes (spec B).
 */
export async function loadAnalyticsInput(
  client: SupabaseClient,
  courseId: string,
  timeZone: string,
  now: Date = new Date()
): Promise<AnalyticsInput> {
  const [concepts, mastery, exams, attempts, sessions, simulations] = await Promise.all([
    listConcepts(client, courseId),
    listConceptMastery(client, courseId),
    listCourseExams(client, courseId),
    listAnalyticsAttempts(client, courseId),
    listAnalyticsSessions(client, courseId),
    fetchSimulationAnalytics(client, courseId),
  ]);

  const conceptRecords: ConceptRecord[] = concepts.map((c) => ({
    conceptId: c.id,
    canonicalName: c.canonical_name,
    conceptType: c.concept_type,
    emphasisScore: c.emphasis_score,
  }));
  const masteryRecords = mastery.map((row) => ({
    conceptId: row.concept_id,
    aggregate: toAggregate(row),
  }));
  const examRecords: ExamRecord[] = exams.map((e) => ({
    examId: e.id,
    title: e.title,
    examAt: e.exam_at,
  }));

  return {
    attempts,
    mastery: masteryRecords,
    concepts: conceptRecords,
    sessions,
    exams: examRecords,
    simulations,
    timeZone,
    now,
  };
}
