import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  CognitiveLevel,
  ConfidenceLevel,
  PriorityFramework,
  QuestionDifficulty,
  QuestionFeedbackReason,
  QuestionSourceType,
  QuestionType,
  SessionStatus,
} from '@avidia/domain';

/**
 * Data access for practice sessions (M7 spec T/V/W/X/AH).
 *
 * The reads here can only ever see safe columns: the database grants clients
 * SELECT on question metadata and option text but NOT on is_correct,
 * correct_position, rationales, or the numeric expected answer (spec K/W).
 * Answers therefore cannot leak into the client bundle before submission —
 * the ONLY way to learn the correct answer is the submit_question_attempt
 * RPC, which locks the attempt in first (spec W). RLS additionally restricts
 * every row to the caller's own courses and to status='active' questions
 * (spec S/AB); a guessed id looks exactly like "does not exist".
 */

export interface PracticeQuestionRow {
  id: string;
  course_id: string;
  concept_id: string | null;
  question_type: QuestionType;
  stem: string;
  difficulty: QuestionDifficulty;
  cognitive_level: CognitiveLevel;
  source_type: QuestionSourceType;
  priority_frameworks: PriorityFramework[];
  options: PracticeOptionRow[];
}

export interface PracticeOptionRow {
  id: string;
  ordinal: number;
  option_text: string;
}

/**
 * Session labels (M10 spec B/AL): the five mode ids join 'practice' and
 * 'adaptive' as honest session_type values — same table, same lifecycle.
 */
export type StudySessionType =
  | 'practice'
  | 'adaptive'
  | 'rapid_response'
  | 'find_the_danger'
  | 'who_first'
  | 'medication_lab'
  | 'boss_battle';

export interface StudySessionRow {
  id: string;
  course_id: string;
  session_type: string;
  status: SessionStatus;
  planned_question_count: number;
  started_at: string;
  completed_at: string | null;
}

/** Revealed truth for one option, returned only AFTER the attempt is locked. */
export interface RevealedOption {
  id: string;
  ordinal: number;
  is_correct: boolean;
  correct_position: number | null;
  rationale: string | null;
}

/**
 * The full aggregate `submit_question_attempt` echoes back after applying
 * the M8 arithmetic transactionally (migration 0008 `v_mastery_json`).
 */
export interface MasteryEcho {
  concept_id: string;
  mastery: number;
  mastery_delta: number;
  attempts_count: number;
  correct_count: number;
  misconception_severity: number;
  review_stage: number;
  next_review_at: string;
  algorithm_version: number;
}

/** submit_question_attempt result: the teaching payload (spec M/W). */
export interface AttemptResult {
  is_correct: boolean;
  rationale: string;
  expected_value: number | null;
  tolerance: number | null;
  answer_unit: string | null;
  rounding_note: string | null;
  options: RevealedOption[];
  /**
   * M8: the authoritative post-update aggregate from the transactional
   * update (null for concept-less questions). The UI deliberately shows only
   * the state label, never the number (spec AG — no fake precision). M9's
   * in-session adaptation feeds these SERVER-returned values back into the
   * pure ranking engine — the client never recomputes mastery arithmetic.
   */
  mastery?: MasteryEcho | null;
}

/** Response payloads mirror the SQL scorer's expected JSON shapes (spec P). */
export type AttemptResponse =
  { selected_option_ids: string[] } | { ordered_option_ids: string[] } | { value: number };

interface QuestionQueryRow extends Omit<PracticeQuestionRow, 'options'> {
  question_options: PracticeOptionRow[];
}

/**
 * All ACTIVE questions of a course with their options in fixed ordinal order
 * (spec B/V). Flagged/retired/rejected questions are invisible by RLS.
 */
export async function listActiveQuestions(
  client: SupabaseClient,
  courseId: string
): Promise<PracticeQuestionRow[]> {
  const { data, error } = await client
    .from('questions')
    .select(
      'id, course_id, concept_id, question_type, stem, difficulty, cognitive_level, ' +
        'source_type, priority_frameworks, question_options(id, ordinal, option_text)'
    )
    .eq('course_id', courseId)
    .eq('status', 'active')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as QuestionQueryRow[]).map((row) => {
    const { question_options, ...question } = row;
    return {
      ...question,
      options: [...question_options].sort((a, b) => a.ordinal - b.ordinal),
    };
  });
}

/**
 * Start a practice or adaptive session (M7 spec T/V; M8 spec U/V). Course
 * ownership is enforced by RLS; the session_type check constraint (migration
 * 0008) allows exactly 'practice' and 'adaptive'.
 */
export async function createStudySession(
  client: SupabaseClient,
  courseId: string,
  plannedQuestionCount: number,
  sessionType: StudySessionType = 'practice',
  requestedDurationMinutes: number | null = null
): Promise<StudySessionRow> {
  const { data, error } = await client
    .from('study_sessions')
    .insert({
      course_id: courseId,
      session_type: sessionType,
      planned_question_count: plannedQuestionCount,
      ...(requestedDurationMinutes === null
        ? {}
        : { requested_duration_minutes: requestedDurationMinutes }),
    })
    .select('id, course_id, session_type, status, planned_question_count, started_at, completed_at')
    .single();
  if (error) throw error;
  return data as StudySessionRow;
}

/**
 * Submit one answer for scoring (spec P/U/W). Scoring happens entirely
 * server-side; the attempt is immutable once written (unique per session and
 * question), and the rationale/answer truths arrive only in the result.
 */
export async function submitAttempt(
  client: SupabaseClient,
  sessionId: string,
  questionId: string,
  response: AttemptResponse,
  responseTimeMs: number | null,
  confidence: ConfidenceLevel | null
): Promise<AttemptResult> {
  const { data, error } = await client.rpc('submit_question_attempt', {
    p_session_id: sessionId,
    p_question_id: questionId,
    p_response: response,
    p_response_time_ms: responseTimeMs,
    p_confidence: confidence,
  });
  if (error) throw error;
  return data as AttemptResult;
}

/** Close a session as completed or abandoned (spec T/X). */
export async function closeStudySession(
  client: SupabaseClient,
  sessionId: string,
  status: 'completed' | 'abandoned'
): Promise<void> {
  const { error } = await client
    .from('study_sessions')
    .update({ status, completed_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('status', 'in_progress');
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// M9: persisted session plan + resume + source provenance (spec O/AB/T)
// ---------------------------------------------------------------------------

export interface SessionPlanRow {
  position: number;
  question_id: string;
  skipped_at: string | null;
}

/**
 * Persist the ordered plan of a freshly created adaptive session in one
 * insert (migration 0009). Written exactly once at session start; this is
 * what a resume reloads (spec O). RLS restricts the rows to the caller's own
 * in-progress session and to questions of the same course.
 */
export async function insertSessionPlan(
  client: SupabaseClient,
  sessionId: string,
  orderedQuestionIds: readonly string[]
): Promise<void> {
  if (orderedQuestionIds.length === 0) return;
  const rows = orderedQuestionIds.map((questionId, index) => ({
    session_id: sessionId,
    position: index + 1,
    question_id: questionId,
  }));
  const { error } = await client.from('study_session_plan').insert(rows);
  if (error) throw error;
}

/** The stored plan of a session, in position order (resume baseline). */
export async function listSessionPlan(
  client: SupabaseClient,
  sessionId: string
): Promise<SessionPlanRow[]> {
  const { data, error } = await client
    .from('study_session_plan')
    .select('position, question_id, skipped_at')
    .eq('session_id', sessionId)
    .order('position', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as SessionPlanRow[];
}

/**
 * Record a skip (spec AB): the ONLY updatable plan column is skipped_at, and
 * the database rejects it once the session is no longer in progress. A skip
 * is neither correct nor incorrect and never reaches the mastery engine.
 */
export async function markPlanSkipped(
  client: SupabaseClient,
  sessionId: string,
  questionId: string
): Promise<void> {
  const { error } = await client
    .from('study_session_plan')
    .update({ skipped_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .eq('question_id', questionId);
  if (error) throw error;
}

/**
 * The student's most recent still-open adaptive session for a course, if any
 * (spec O). Used to offer RESUME after an app restart or refresh.
 */
export async function findResumableSession(
  client: SupabaseClient,
  courseId: string
): Promise<StudySessionRow | null> {
  const { data, error } = await client
    .from('study_sessions')
    .select('id, course_id, session_type, status, planned_question_count, started_at, completed_at')
    .eq('course_id', courseId)
    .eq('session_type', 'adaptive')
    .eq('status', 'in_progress')
    .order('started_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = (data ?? [])[0];
  return row ? (row as unknown as StudySessionRow) : null;
}

/**
 * The attempts already recorded for one session (spec O). Attempts remain
 * the single source of answer truth — a resume subtracts these from the
 * stored plan instead of keeping any duplicate progress state.
 */
export async function listSessionAttempts(
  client: SupabaseClient,
  sessionId: string
): Promise<{ question_id: string; is_correct: boolean }[]> {
  const { data, error } = await client
    .from('question_attempts')
    .select('question_id, is_correct')
    .eq('session_id', sessionId);
  if (error) throw error;
  return (data ?? []) as unknown as { question_id: string; is_correct: boolean }[];
}

/** A human-readable source reference for one question (spec T). */
export interface QuestionSourceRef {
  document_filename: string;
  /** e.g. {"type":"pptx","slide":17,"title":"..."} — shaped by the indexer. */
  source_locator: Record<string, unknown> | null;
}

/**
 * Where a question came from, in student terms (spec T): the original
 * document filename plus the chunk's human locator (slide/page/section).
 * Chunk ids, embeddings, and similarity scores are never exposed — the
 * column grants don't allow reading them in the first place.
 */
export async function listQuestionSourceRefs(
  client: SupabaseClient,
  questionId: string
): Promise<QuestionSourceRef[]> {
  const { data, error } = await client
    .from('question_sources')
    .select('documents(original_filename), source_chunks(source_locator)')
    .eq('question_id', questionId);
  if (error) throw error;
  const rows = (data ?? []) as unknown as {
    documents: { original_filename: string } | null;
    source_chunks: { source_locator: Record<string, unknown> | null } | null;
  }[];
  return rows
    .filter((row) => row.documents !== null)
    .map((row) => ({
      document_filename: row.documents!.original_filename,
      source_locator: row.source_chunks?.source_locator ?? null,
    }));
}

/**
 * Student flag on a question (spec AH). Never changes the question or its
 * answer — it records a review request for later human/AI triage.
 */
export async function submitQuestionFeedback(
  client: SupabaseClient,
  questionId: string,
  courseId: string,
  reason: QuestionFeedbackReason,
  comment: string | null
): Promise<void> {
  const { error } = await client.from('question_feedback').insert({
    question_id: questionId,
    course_id: courseId,
    reason,
    comment: comment && comment.trim().length > 0 ? comment.trim() : null,
  });
  if (error) throw error;
}
