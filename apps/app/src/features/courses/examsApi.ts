import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Data access for exams and their module associations (M2).
 *
 * Exams inherit ownership through their course (RLS), and the exam_modules
 * join table additionally requires — in the database policy itself — that the
 * exam and the module belong to the SAME course owned by the caller, so
 * cross-user or cross-course associations are impossible even with forged
 * requests. `exam_at` is a UTC instant (ADR-0007).
 */

export interface Exam {
  id: string;
  course_id: string;
  title: string;
  exam_at: string;
  weight: number | null;
  created_at: string;
  updated_at: string;
}

export interface ExamWithModules extends Exam {
  module_ids: string[];
}

export interface ExamInsert {
  title: string;
  exam_at: string;
  weight: number | null;
}

/** The only columns a student may change on an exam. */
export interface ExamUpdate {
  title?: string;
  exam_at?: string;
  weight?: number | null;
}

const UPDATABLE_FIELDS: ReadonlyArray<keyof ExamUpdate> = ['title', 'exam_at', 'weight'];

/** Strip anything that is not an explicitly updatable field. */
export function sanitizeExamUpdate(input: Record<string, unknown>): ExamUpdate {
  const out: Record<string, unknown> = {};
  for (const field of UPDATABLE_FIELDS) {
    if (field in input) out[field] = input[field];
  }
  return out as ExamUpdate;
}

interface RawExamRow extends Exam {
  exam_modules: { module_id: string }[];
}

function toExamWithModules(row: RawExamRow): ExamWithModules {
  const { exam_modules, ...exam } = row;
  return { ...exam, module_ids: (exam_modules ?? []).map((link) => link.module_id) };
}

/** Exams of a course, soonest first, each with its associated module ids. */
export async function listExams(
  client: SupabaseClient,
  courseId: string
): Promise<ExamWithModules[]> {
  const { data, error } = await client
    .from('exams')
    .select('*, exam_modules(module_id)')
    .eq('course_id', courseId)
    .order('exam_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as RawExamRow[]).map(toExamWithModules);
}

export async function fetchExam(
  client: SupabaseClient,
  examId: string
): Promise<ExamWithModules | null> {
  const { data, error } = await client
    .from('exams')
    .select('*, exam_modules(module_id)')
    .eq('id', examId)
    .maybeSingle();
  if (error) throw error;
  return data ? toExamWithModules(data as unknown as RawExamRow) : null;
}

export async function createExam(
  client: SupabaseClient,
  courseId: string,
  input: ExamInsert,
  moduleIds: readonly string[]
): Promise<ExamWithModules> {
  const { data, error } = await client
    .from('exams')
    .insert({ ...input, course_id: courseId })
    .select()
    .single();
  if (error) throw error;
  const exam = data as Exam;
  await setExamModules(client, exam.id, moduleIds);
  return { ...exam, module_ids: [...moduleIds] };
}

export async function updateExam(
  client: SupabaseClient,
  examId: string,
  update: ExamUpdate,
  moduleIds?: readonly string[]
): Promise<void> {
  const sanitized = sanitizeExamUpdate(update as Record<string, unknown>);
  if (Object.keys(sanitized).length > 0) {
    const { error } = await client.from('exams').update(sanitized).eq('id', examId);
    if (error) throw error;
  }
  if (moduleIds) await setExamModules(client, examId, moduleIds);
}

/** Replace the exam's module associations with exactly `moduleIds`. */
export async function setExamModules(
  client: SupabaseClient,
  examId: string,
  moduleIds: readonly string[]
): Promise<void> {
  const { error: deleteError } = await client.from('exam_modules').delete().eq('exam_id', examId);
  if (deleteError) throw deleteError;
  if (moduleIds.length === 0) return;
  const rows = moduleIds.map((moduleId) => ({ exam_id: examId, module_id: moduleId }));
  const { error } = await client.from('exam_modules').insert(rows);
  if (error) throw error;
}

/** Deleting an exam also removes its module associations (FK cascade). */
export async function deleteExam(client: SupabaseClient, examId: string): Promise<void> {
  const { error } = await client.from('exams').delete().eq('id', examId);
  if (error) throw error;
}
