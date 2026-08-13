import type { SupabaseClient } from '@supabase/supabase-js';
import type { CourseStatus } from '@avidia/domain';

/**
 * Data access for courses (M2). Same discipline as profileApi:
 * 1. The database enforces ownership with row-level security — the only
 *    enforcement that counts.
 * 2. Every query here is ALSO scoped to the caller's own user id, so the
 *    client never even attempts a cross-user read, and a future caching
 *    layer can key rows by user safely.
 *
 * Screens never talk to supabase-js directly; they call these functions, so
 * caching/offline support can be added behind this boundary later (M13).
 */

export interface Course {
  id: string;
  user_id: string;
  title: string;
  term: string | null;
  institution_name: string | null;
  status: CourseStatus;
  created_at: string;
  updated_at: string;
}

export interface CourseSummary extends Course {
  /** Modules in this course (count only, for the course card). */
  module_count: number;
  /** All exams (id/title/exam_at) so the card can show the next one. */
  exams: { id: string; title: string; exam_at: string }[];
}

export interface CourseInsert {
  title: string;
  term: string | null;
  institution_name: string | null;
}

/** The only columns a student may change on a course. */
export interface CourseUpdate {
  title?: string;
  term?: string | null;
  institution_name?: string | null;
  status?: CourseStatus;
}

const UPDATABLE_FIELDS: ReadonlyArray<keyof CourseUpdate> = [
  'title',
  'term',
  'institution_name',
  'status',
];

/** Strip anything that is not an explicitly updatable field. */
export function sanitizeCourseUpdate(input: Record<string, unknown>): CourseUpdate {
  const out: Record<string, unknown> = {};
  for (const field of UPDATABLE_FIELDS) {
    if (field in input) out[field] = input[field];
  }
  return out as CourseUpdate;
}

const SUMMARY_SELECT = '*, modules(count), exams(id, title, exam_at)';

interface RawSummaryRow extends Course {
  modules: { count: number }[];
  exams: { id: string; title: string; exam_at: string }[];
}

function toSummary(row: RawSummaryRow): CourseSummary {
  const { modules, exams, ...course } = row;
  return {
    ...course,
    module_count: modules?.[0]?.count ?? 0,
    exams: exams ?? [],
  };
}

/** All of the caller's courses, newest first, with card info. */
export async function listOwnCourses(
  client: SupabaseClient,
  userId: string
): Promise<CourseSummary[]> {
  const { data, error } = await client
    .from('courses')
    .select(SUMMARY_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as unknown as RawSummaryRow[]).map(toSummary);
}

/** One of the caller's courses by id; null when absent (or not theirs). */
export async function fetchOwnCourse(
  client: SupabaseClient,
  userId: string,
  courseId: string
): Promise<Course | null> {
  const { data, error } = await client
    .from('courses')
    .select('*')
    .eq('id', courseId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as Course | null) ?? null;
}

export async function createCourse(
  client: SupabaseClient,
  userId: string,
  input: CourseInsert
): Promise<Course> {
  const { data, error } = await client
    .from('courses')
    .insert({ ...input, user_id: userId })
    .select()
    .single();
  if (error) throw error;
  return data as Course;
}

export async function updateOwnCourse(
  client: SupabaseClient,
  userId: string,
  courseId: string,
  update: CourseUpdate
): Promise<Course> {
  const { data, error } = await client
    .from('courses')
    .update(sanitizeCourseUpdate(update as Record<string, unknown>))
    .eq('id', courseId)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data as Course;
}

/** Soft retirement: the course and its data stay, hidden from the active list. */
export async function archiveOwnCourse(
  client: SupabaseClient,
  userId: string,
  courseId: string
): Promise<Course> {
  return updateOwnCourse(client, userId, courseId, { status: 'archived' });
}

export async function unarchiveOwnCourse(
  client: SupabaseClient,
  userId: string,
  courseId: string
): Promise<Course> {
  return updateOwnCourse(client, userId, courseId, { status: 'active' });
}

/**
 * Hard delete. CASCADES: permanently removes the course AND its modules,
 * exams, and exam-module associations (FKs in migration 0002). Never touches
 * the user's profile. UI must confirm before calling this.
 */
export async function deleteOwnCourse(
  client: SupabaseClient,
  userId: string,
  courseId: string
): Promise<void> {
  const { error } = await client.from('courses').delete().eq('id', courseId).eq('user_id', userId);
  if (error) throw error;
}
