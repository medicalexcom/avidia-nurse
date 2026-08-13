import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Data access for modules (M2). Modules inherit ownership through their
 * course; row-level security allows access only when the parent course
 * belongs to the caller, and `course_id` is not updatable (column grants),
 * so a module can never move to another user's course.
 */

export interface Module {
  id: string;
  course_id: string;
  title: string;
  sequence: number;
  created_at: string;
  updated_at: string;
}

/** Modules of a course in display order. */
export async function listModules(client: SupabaseClient, courseId: string): Promise<Module[]> {
  const { data, error } = await client
    .from('modules')
    .select('*')
    .eq('course_id', courseId)
    .order('sequence', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Module[];
}

export async function createModule(
  client: SupabaseClient,
  courseId: string,
  title: string,
  sequence: number
): Promise<Module> {
  const { data, error } = await client
    .from('modules')
    .insert({ course_id: courseId, title, sequence })
    .select()
    .single();
  if (error) throw error;
  return data as Module;
}

export async function renameModule(
  client: SupabaseClient,
  moduleId: string,
  title: string
): Promise<Module> {
  const { data, error } = await client
    .from('modules')
    .update({ title })
    .eq('id', moduleId)
    .select()
    .single();
  if (error) throw error;
  return data as Module;
}

/**
 * Persist a new display order (gapless sequences from @avidia/domain
 * `resequence`). Small N: one update per changed module is fine at M2 scale.
 */
export async function saveModuleOrder(
  client: SupabaseClient,
  order: ReadonlyArray<{ id: string; sequence: number }>
): Promise<void> {
  for (const { id, sequence } of order) {
    const { error } = await client.from('modules').update({ sequence }).eq('id', id);
    if (error) throw error;
  }
}

/** Deleting a module also removes its exam associations (FK cascade). */
export async function deleteModule(client: SupabaseClient, moduleId: string): Promise<void> {
  const { error } = await client.from('modules').delete().eq('id', moduleId);
  if (error) throw error;
}
