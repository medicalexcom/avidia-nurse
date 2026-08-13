import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Minimal student profile (Playbook §6 "User" entity; stored in
 * public.profiles, 1:1 with auth.users).
 *
 * Ownership is enforced twice:
 * 1. In the database by row-level security (the only enforcement that counts —
 *    a student cannot read another profile even with a hand-crafted request).
 * 2. Here, by always scoping queries to the caller's own user id, so the
 *    client never even attempts a cross-user read.
 */

export const PROGRAM_TYPES = ['absn', 'bsn', 'adn', 'other'] as const;
export type ProgramType = (typeof PROGRAM_TYPES)[number];

export interface Profile {
  id: string;
  email: string;
  role: string;
  timezone: string | null;
  program_type: string | null;
  created_at: string;
}

/** The only columns a student may change. Everything else is read-only. */
export interface ProfileUpdate {
  timezone?: string | null;
  program_type?: ProgramType | null;
}

const UPDATABLE_FIELDS: ReadonlyArray<keyof ProfileUpdate> = ['timezone', 'program_type'];

/** Strip anything that is not an explicitly updatable field. */
export function sanitizeProfileUpdate(input: Record<string, unknown>): ProfileUpdate {
  const out: Record<string, unknown> = {};
  for (const field of UPDATABLE_FIELDS) {
    if (field in input) out[field] = input[field];
  }
  return out as ProfileUpdate;
}

export async function fetchOwnProfile(
  client: SupabaseClient,
  userId: string
): Promise<Profile | null> {
  const { data, error } = await client
    .from('profiles')
    .select('id, email, role, timezone, program_type, created_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as Profile | null) ?? null;
}

export async function updateOwnProfile(
  client: SupabaseClient,
  userId: string,
  update: ProfileUpdate
): Promise<Profile> {
  const safe = sanitizeProfileUpdate(update as Record<string, unknown>);
  const { data, error } = await client
    .from('profiles')
    .update(safe)
    .eq('id', userId)
    .select('id, email, role, timezone, program_type, created_at')
    .single();
  if (error) throw error;
  return data as Profile;
}
