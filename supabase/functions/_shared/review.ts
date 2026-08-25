/**
 * Shared helpers for the content-review edge function.
 *
 * Content review needs the answer-revealing columns (`rationale`,
 * `is_correct`, `correct_position`, option rationale) and the ability to
 * write `status` — both are structurally impossible for the authenticated
 * client role: ADR-0018 excludes them from the `authenticated` column
 * grants and RLS forbids status writes entirely ("the schema, not
 * application code, carries the guarantee"). This function reaches them
 * only through the service-role client (bypasses RLS, same pattern already
 * used by the M14 billing functions), gated by requireReviewer below —
 * that gate, not RLS, is what makes this safe.
 */

import { requireUser, serviceClient } from './http.ts';

/** Distinguishes "not signed in" (401) from "signed in, not a reviewer" (403). */
export class ReviewerAuthError extends Error {
  status: 401 | 403;
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Resolve the caller and verify `profiles.role = 'reviewer'`. There is no
 * client path to set this — `grant update (timezone, program_type)` in
 * migration 0001 deliberately excludes `role` — so it can only be granted by
 * an operator running SQL directly in the Supabase dashboard, e.g.:
 *   update public.profiles set role = 'reviewer' where email = '...';
 */
export async function requireReviewer(
  req: Request
): Promise<{ id: string; email: string | null }> {
  let user: { id: string; email: string | null };
  try {
    user = await requireUser(req);
  } catch {
    throw new ReviewerAuthError(401, 'unauthorized');
  }
  const db = serviceClient();
  const rows = (await db.select('profiles', `select=role&id=eq.${user.id}`)) as Array<{
    role?: string;
  }>;
  if (rows[0]?.role !== 'reviewer') {
    throw new ReviewerAuthError(403, 'forbidden');
  }
  return user;
}

// ---------------------------------------------------------------------------
// Field-length limits — mirror the CHECK constraints in migration 0007 /
// ADR-0018 exactly, so a reviewer gets a clear 400 instead of an opaque
// Postgres constraint-violation error. Keep these in sync with the source of
// truth (the migration) if either changes.
// ---------------------------------------------------------------------------
export const STEM_MIN = 20;
export const STEM_MAX = 3000;
export const QUESTION_RATIONALE_MIN = 20;
export const QUESTION_RATIONALE_MAX = 4000;
export const OPTION_TEXT_MIN = 1;
export const OPTION_TEXT_MAX = 500;
export const OPTION_RATIONALE_MAX = 1000;

/** The only statuses a review decision can move a question *from*. */
export const REVIEWABLE_STATUSES = ['generated', 'flagged'] as const;
export type ReviewableStatus = (typeof REVIEWABLE_STATUSES)[number];

/**
 * A review decision's target status. Deliberately excludes 'retired' (that's
 * an automated lifecycle state for evidence loss, ADR-0018 §5 — a reviewer
 * decision is never how a question gets there) and 'generated' (the queue's
 * own starting state, never a decision outcome).
 */
export const DECISIONS = { approve: 'active', reject: 'rejected' } as const;
export type Decision = keyof typeof DECISIONS;

export function isDecision(value: unknown): value is Decision {
  return value === 'approve' || value === 'reject';
}
