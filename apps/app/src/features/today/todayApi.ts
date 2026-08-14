import type { SupabaseClient } from '@supabase/supabase-js';

import type { CourseSummary } from '../courses/coursesApi';

/**
 * Data plumbing for the Today screen — M9 (spec A/P/AC).
 *
 * Reads are owner-scoped by RLS exactly like the rest of the app; the screen
 * combines these rows with the pure `@avidia/mastery` ranking and never
 * computes priorities itself (spec C).
 */

/** One recent session for the lightweight history list (spec AC). */
export interface RecentSessionRow {
  id: string;
  session_type: string;
  status: string;
  requested_duration_minutes: number | null;
  started_at: string;
  completed_at: string | null;
  /** Activities completed — counted from question_attempts, never stored twice. */
  attempt_count: number;
}

/**
 * The student's most recent sessions for a course (spec AC — a simple
 * history foundation; M12 does deep analytics). The activity count comes
 * from `question_attempts(count)` so no duplicate progress state exists.
 */
export async function listRecentSessions(
  client: SupabaseClient,
  courseId: string,
  limit = 5
): Promise<RecentSessionRow[]> {
  const { data, error } = await client
    .from('study_sessions')
    .select(
      'id, session_type, status, requested_duration_minutes, started_at, completed_at, ' +
        'question_attempts(count)'
    )
    .eq('course_id', courseId)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = (data ?? []) as unknown as (Omit<RecentSessionRow, 'attempt_count'> & {
    question_attempts: { count: number }[];
  })[];
  return rows.map((row) => {
    const { question_attempts, ...session } = row;
    return { ...session, attempt_count: question_attempts?.[0]?.count ?? 0 };
  });
}

/**
 * Timestamps of the student's own recorded answers, newest first, across
 * ALL courses — the only input the M10 streak needs (ADR-0027). Attempts
 * are server-written and RLS-scoped to the owner, so the streak can always
 * be recomputed and never needs stored state.
 */
export async function listOwnAttemptTimes(client: SupabaseClient, limit = 400): Promise<string[]> {
  const { data, error } = await client
    .from('question_attempts')
    .select('created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as { created_at: string }[]).map((row) => row.created_at);
}

/**
 * Intelligent course default (spec P), pure and testable: prefer the ACTIVE
 * course whose next exam is soonest (exam pressure is the strongest signal
 * of "what today is about"); otherwise the most recently created active
 * course; otherwise the newest course of any status. Null when none exist.
 */
export function pickDefaultCourseId(courses: readonly CourseSummary[], now: Date): string | null {
  if (courses.length === 0) return null;
  const active = courses.filter((course) => course.status === 'active');
  const candidates = active.length > 0 ? active : courses;

  let best: { courseId: string; examAt: number } | null = null;
  for (const course of candidates) {
    for (const exam of course.exams) {
      const at = Date.parse(exam.exam_at);
      if (Number.isFinite(at) && at >= now.getTime() && (best === null || at < best.examAt)) {
        best = { courseId: course.id, examAt: at };
      }
    }
  }
  if (best) return best.courseId;
  // listOwnCourses orders newest-first; index access is guarded above.
  return candidates[0]?.id ?? null;
}
