/**
 * Content review queue: list generated/flagged questions and let a reviewer
 * approve, reject, or lightly edit wording before a question ever reaches a
 * student (ADR-0018 §4; docs/architecture-decisions/ADR-0018-question-schema.md).
 * Replaces hand-editing Supabase rows for this workflow.
 *
 * Access: `profiles.role = 'reviewer'` — see requireReviewer in
 * ../_shared/review.ts for how that's granted (SQL only, no client path).
 *
 * Scope, deliberately: edits touch wording only (question stem, question and
 * option rationale, option text) — never `is_correct`/`correct_position`.
 * Re-authoring which answer is correct is a materially different, higher-
 * risk operation than fixing a typo or an unclear rationale, and isn't
 * covered by this first pass. If a question's correctness is wrong, reject
 * it (it can be regenerated) rather than trying to hand-fix it here.
 *
 * One POST endpoint, action-discriminated (matches how the app already calls
 * edge functions via `client.functions.invoke`, which posts a JSON body):
 *   { action: 'list', status?, course_id?, limit? }
 *   { action: 'decide', question_id, decision?, edits? }
 */

import { corsHeaders, json, serviceClient } from '../_shared/http.ts';
import {
  DECISIONS,
  isDecision,
  OPTION_RATIONALE_MAX,
  OPTION_TEXT_MAX,
  OPTION_TEXT_MIN,
  QUESTION_RATIONALE_MAX,
  QUESTION_RATIONALE_MIN,
  requireReviewer,
  REVIEWABLE_STATUSES,
  ReviewerAuthError,
  STEM_MAX,
  STEM_MIN,
  type Decision,
  type ReviewableStatus,
} from '../_shared/review.ts';

const QUESTION_SELECT =
  'id,course_id,concept_id,question_type,stem,difficulty,cognitive_level,source_type,' +
  'generation_source,priority_frameworks,rationale,expected_value,tolerance,answer_unit,' +
  'rounding_note,status,safety_flags,content_hash,created_at,updated_at,' +
  'courses(title),' +
  'question_options(id,ordinal,option_text,is_correct,correct_position,rationale)';

interface OptionEdit {
  id: string;
  option_text?: string;
  rationale?: string | null;
}

interface Edits {
  stem?: string;
  rationale?: string;
  options?: OptionEdit[];
}

function inLenRange(value: string, min: number, max: number): boolean {
  return value.length >= min && value.length <= max;
}

/** Mirrors the CHECK constraints in migration 0007 — see review.ts for the limits. */
function validateEdits(edits: Edits | undefined): string[] {
  if (!edits) return [];
  const errors: string[] = [];
  if (edits.stem !== undefined && !inLenRange(edits.stem, STEM_MIN, STEM_MAX)) {
    errors.push(`stem must be ${STEM_MIN}-${STEM_MAX} characters`);
  }
  if (
    edits.rationale !== undefined &&
    !inLenRange(edits.rationale, QUESTION_RATIONALE_MIN, QUESTION_RATIONALE_MAX)
  ) {
    errors.push(`rationale must be ${QUESTION_RATIONALE_MIN}-${QUESTION_RATIONALE_MAX} characters`);
  }
  for (const opt of edits.options ?? []) {
    if (typeof opt.id !== 'string' || opt.id.length === 0) {
      errors.push('every option edit requires an id');
      continue;
    }
    if (
      opt.option_text !== undefined &&
      !inLenRange(opt.option_text, OPTION_TEXT_MIN, OPTION_TEXT_MAX)
    ) {
      errors.push(`option ${opt.id}: text must be ${OPTION_TEXT_MIN}-${OPTION_TEXT_MAX} characters`);
    }
    if (typeof opt.rationale === 'string' && opt.rationale.length > OPTION_RATIONALE_MAX) {
      errors.push(`option ${opt.id}: rationale must be at most ${OPTION_RATIONALE_MAX} characters`);
    }
  }
  return errors;
}

async function handleList(req: Request): Promise<Response> {
  let body: {
    status?: unknown;
    course_id?: unknown;
    limit?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const statuses: ReviewableStatus[] = Array.isArray(body.status)
    ? body.status.filter((s): s is ReviewableStatus => REVIEWABLE_STATUSES.includes(s as never))
    : [...REVIEWABLE_STATUSES];
  const wanted = statuses.length > 0 ? statuses : [...REVIEWABLE_STATUSES];

  const limit = Math.min(
    200,
    Math.max(1, typeof body.limit === 'number' && Number.isFinite(body.limit) ? body.limit : 50)
  );

  const params = new URLSearchParams();
  params.set('select', QUESTION_SELECT);
  params.set('status', `in.(${wanted.join(',')})`);
  params.set('order', 'created_at.asc');
  params.set('limit', String(limit));
  params.set('question_options.order', 'ordinal.asc');
  if (typeof body.course_id === 'string' && body.course_id.length > 0) {
    params.set('course_id', `eq.${body.course_id}`);
  }

  try {
    const db = serviceClient();
    const questions = await db.select('questions', params.toString());
    return json({ questions });
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', fn: 'content-review:list', err: String(err) }));
    return json({ error: 'list_failed' }, 500);
  }
}

async function handleDecide(req: Request): Promise<Response> {
  let body: {
    question_id?: unknown;
    decision?: unknown;
    edits?: Edits;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }

  const questionId = body.question_id;
  if (typeof questionId !== 'string' || questionId.length === 0) {
    return json({ error: 'question_id is required' }, 400);
  }
  const decision: Decision | undefined =
    body.decision === undefined ? undefined : isDecision(body.decision) ? body.decision : undefined;
  if (body.decision !== undefined && decision === undefined) {
    return json({ error: 'decision must be "approve" or "reject"' }, 400);
  }

  const validationErrors = validateEdits(body.edits);
  if (validationErrors.length > 0) {
    return json({ error: 'validation_failed', details: validationErrors }, 400);
  }

  const db = serviceClient();

  // The question must exist and still be in a reviewable status — a second
  // reviewer (or the same one, double-submitting) acting on an already
  // decided question is a conflict, not a silent no-op.
  const existing = (await db.select(
    'questions',
    `select=id,status,question_options(id)&id=eq.${questionId}`
  )) as Array<{ id: string; status: string; question_options: Array<{ id: string }> }>;
  const question = existing[0];
  if (!question) return json({ error: 'not_found' }, 404);
  if (!REVIEWABLE_STATUSES.includes(question.status as never)) {
    return json({ error: 'already_decided', status: question.status }, 409);
  }

  const validOptionIds = new Set(question.question_options.map((o) => o.id));
  for (const opt of body.edits?.options ?? []) {
    if (!validOptionIds.has(opt.id)) {
      return json({ error: `option ${opt.id} does not belong to this question` }, 400);
    }
  }

  try {
    for (const opt of body.edits?.options ?? []) {
      const patch: Record<string, unknown> = {};
      if (opt.option_text !== undefined) patch.option_text = opt.option_text;
      if (opt.rationale !== undefined) patch.rationale = opt.rationale;
      if (Object.keys(patch).length === 0) continue;
      const res = await db.update('question_options', { id: opt.id }, patch);
      if (!res.ok) throw new Error(`option update failed: ${res.status}`);
    }

    const questionPatch: Record<string, unknown> = {};
    if (body.edits?.stem !== undefined) questionPatch.stem = body.edits.stem;
    if (body.edits?.rationale !== undefined) questionPatch.rationale = body.edits.rationale;
    if (decision !== undefined) questionPatch.status = DECISIONS[decision];

    if (Object.keys(questionPatch).length > 0) {
      const res = await db.update('questions', { id: questionId }, questionPatch);
      if (!res.ok) throw new Error(`question update failed: ${res.status}`);
    }

    console.log(
      JSON.stringify({
        level: 'info',
        fn: 'content-review:decide',
        question_id: questionId,
        decision: decision ?? null,
        edited: Boolean(body.edits),
      })
    );
    return json({ ok: true });
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', fn: 'content-review:decide', err: String(err) }));
    return json({ error: 'decide_failed' }, 500);
  }
}

Deno.serve(async (req) => {
  // The browser preflights every cross-origin POST with an OPTIONS request
  // (the app is served from GitHub Pages, this function from *.supabase.co)
  // — it must succeed with no auth/body work before the real request is
  // even sent, or the browser blocks the actual call before it gets here.
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  try {
    await requireReviewer(req);
  } catch (err) {
    if (err instanceof ReviewerAuthError) return json({ error: err.message }, err.status);
    return json({ error: 'unauthorized' }, 401);
  }

  // Peek at the action via a clone so the body stream is still intact for
  // whichever handler runs below (each reads req.json() itself).
  let action: unknown;
  try {
    const cloned = req.clone();
    const parsed = await cloned.json();
    action = parsed?.action;
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }

  if (action === 'list') return handleList(req);
  if (action === 'decide') return handleDecide(req);
  return json({ error: 'action must be "list" or "decide"' }, 400);
});
