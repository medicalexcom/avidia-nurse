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

/** submit_question_attempt result: the teaching payload (spec M/W). */
export interface AttemptResult {
  is_correct: boolean;
  rationale: string;
  expected_value: number | null;
  tolerance: number | null;
  answer_unit: string | null;
  rounding_note: string | null;
  options: RevealedOption[];
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

/** Start a practice session (spec T/V). course ownership enforced by RLS. */
export async function createStudySession(
  client: SupabaseClient,
  courseId: string,
  plannedQuestionCount: number
): Promise<StudySessionRow> {
  const { data, error } = await client
    .from('study_sessions')
    .insert({
      course_id: courseId,
      session_type: 'practice',
      planned_question_count: plannedQuestionCount,
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
