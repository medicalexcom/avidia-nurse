/**
 * Simulation data access — M11 (spec V/W/X/AW).
 *
 * Thin, typed wrappers over the SECURITY DEFINER RPCs from migration 0011.
 * The client NEVER computes physiology, validity, or scores: every submitted
 * action goes to the server-side interpreter, and the only payload that ever
 * comes back mid-session is the redacted ClientView (spec N). RLS scopes all
 * reads to the signed-in owner.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// Deep import (same convention as @avidia/assessment/src/mix): the package
// barrel also exports the validator, which pulls node-only modules the web
// bundle must not see.
import type { ClientView } from '@avidia/simulation/src/redact';

/** Metadata row of a seeded case (the `definition` column is not selectable). */
export interface SimulationCaseRow {
  id: string;
  case_key: string;
  case_version: number;
  engine_version: number;
  status: string;
  title: string;
  description: string;
  difficulty: string;
  scenario_type: string;
  estimated_duration_minutes: number;
  owner_id: string | null;
  course_id: string | null;
}

/** Owner-visible session row (state/score stay server-side, spec N). */
export interface SimulationSessionRow {
  id: string;
  course_id: string;
  case_id: string;
  case_version: number;
  engine_version: number;
  status: 'active' | 'completed' | 'abandoned';
  outcome_id: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface StartSimulationResult {
  session_id: string;
  resumed: boolean;
  status: string;
  view: ClientView;
}

export interface SimulationActionResult {
  rejected:
    'unknown_action' | 'missing_prompt_param' | 'unknown_prompt' | 'simulation_completed' | null;
  /** Student-visible events only (spec I/N). */
  events: Array<Record<string, unknown> & { type: string; atMinutes?: number }>;
  view: ClientView;
}

export interface SimulationViewResult {
  session_id: string;
  status: 'active' | 'completed' | 'abandoned';
  started_at: string;
  completed_at: string | null;
  view: ClientView;
}

export interface SimulationDebrief {
  session_id: string;
  case: {
    caseKey: string;
    title: string;
    caseVersion: number;
    engineVersion: number;
    difficulty: string;
    scenarioType: string;
  };
  outcome: {
    outcomeId: string;
    label: string;
    kind: string;
    summary: string;
    atMinutes: number;
  };
  durationMinutes: number;
  score: {
    algorithmVersion: number;
    earned: number;
    possible: number;
    dimensions: Record<string, { earned: number; possible: number }>;
    entries: Array<{
      id: string;
      dimension: string;
      points: number;
      earned: boolean;
      label: string;
    }>;
    missedCriticalActions: Array<{ criticalId: string; label: string }>;
    unsafeActionsTaken: Array<{ actionId: string; classification: string }>;
  };
  timeline: Array<{
    seq: number;
    actionId: string;
    label: string;
    params: Record<string, unknown>;
    rejected: string | null;
    atMinutes: number;
    events: Array<Record<string, unknown> & { type: string }>;
  }>;
  keyCues: Array<{ id: string; system: string; text: string; revealed: boolean }>;
  missedCriticalActions: Array<{ criticalId: string; label: string }>;
  unsafeActionsTaken: Array<{ actionId: string; classification: string }>;
  evidence: Array<{
    conceptId: string;
    conceptName: string;
    isCorrect: boolean;
    masteryBefore: number;
    masteryAfter: number;
  }>;
  recommendations: string[];
}

/** List the active seeded case library (metadata only, spec AF). */
export async function listSimulationCases(
  client: SupabaseClient,
  courseId?: string
): Promise<SimulationCaseRow[]> {
  let query = client
    .from('simulation_cases')
    .select(
      'id, case_key, case_version, engine_version, status, title, description, difficulty, scenario_type, estimated_duration_minutes, owner_id, course_id'
    )
    .eq('status', 'active');
  if (courseId) query = query.or(`owner_id.is.null,course_id.eq.${courseId}`);
  const { data, error } = await query.order('case_key');
  if (error) throw error;
  return (data ?? []) as SimulationCaseRow[];
}

/** The owner's sessions in a course, newest first (resume + history, spec X). */
export async function listOwnSimulationSessions(
  client: SupabaseClient,
  courseId: string
): Promise<SimulationSessionRow[]> {
  const { data, error } = await client
    .from('simulation_sessions')
    .select(
      'id, course_id, case_id, case_version, engine_version, status, outcome_id, started_at, completed_at'
    )
    .eq('course_id', courseId)
    .order('started_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as SimulationSessionRow[];
}

/** Start (or resume — spec X) a simulation for a case in the owner's course. */
export async function startSimulation(
  client: SupabaseClient,
  courseId: string,
  caseKey: string
): Promise<StartSimulationResult> {
  const { data, error } = await client.rpc('start_simulation', {
    p_course_id: courseId,
    p_case_key: caseKey,
  });
  if (error) throw error;
  return data as StartSimulationResult;
}

/**
 * Submit one clinical action (spec E/W/Y). The idempotency key makes retries
 * safe: replaying the same key returns the ORIGINAL stored result, so a
 * double-tapped "Administer medication" can never administer twice.
 */
export async function submitSimulationAction(
  client: SupabaseClient,
  sessionId: string,
  actionId: string,
  params: Record<string, unknown>,
  idempotencyKey: string
): Promise<SimulationActionResult> {
  const { data, error } = await client.rpc('simulation_act', {
    p_session_id: sessionId,
    p_action_id: actionId,
    p_params: params,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  return data as SimulationActionResult;
}

/** Rebuild the redacted view from the authoritative server state (spec X). */
export async function getSimulationView(
  client: SupabaseClient,
  sessionId: string
): Promise<SimulationViewResult> {
  const { data, error } = await client.rpc('get_simulation_view', {
    p_session_id: sessionId,
  });
  if (error) throw error;
  return data as SimulationViewResult;
}

/** Abandon an active session (spec V): no score, no mastery evidence. */
export async function abandonSimulation(client: SupabaseClient, sessionId: string): Promise<void> {
  const { error } = await client.rpc('abandon_simulation', { p_session_id: sessionId });
  if (error) throw error;
}

/** Full debrief for a COMPLETED session (spec AQ/AR) — hidden info included. */
export async function getSimulationDebrief(
  client: SupabaseClient,
  sessionId: string
): Promise<SimulationDebrief> {
  const { data, error } = await client.rpc('get_simulation_debrief', {
    p_session_id: sessionId,
  });
  if (error) throw error;
  return data as SimulationDebrief;
}

/** Random idempotency key for one submission attempt (spec Y). */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
