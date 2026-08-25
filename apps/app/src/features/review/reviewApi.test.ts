import type { SupabaseClient } from '@supabase/supabase-js';

import { decideReviewQuestion, fetchReviewQueue, type ReviewQuestion } from './reviewApi';

/**
 * Content-review client tests. The edge function itself (Deno) is out of
 * reach of this Jest suite — these pin the client's contract: what it sends
 * `content-review`, and how it maps the function's error shapes to
 * reviewer-facing messages. See supabase/functions/content-review/index.ts
 * for the server side.
 */

function functionsClient(result: {
  data?: unknown;
  error?: { context?: { status?: number } } | null;
}): { client: SupabaseClient; invoke: jest.Mock } {
  const invoke = jest.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }));
  return { client: { functions: { invoke } } as unknown as SupabaseClient, invoke };
}

const sampleQuestion: ReviewQuestion = {
  id: 'q-1',
  course_id: 'course-1',
  courses: { title: 'Med-Surg I' },
  concept_id: null,
  question_type: 'single_best_answer',
  stem: 'A client reports chest pain. What is the priority nursing action?',
  difficulty: 'moderate',
  cognitive_level: 'prioritization',
  source_type: 'course_grounded',
  generation_source: 'document_pipeline',
  priority_frameworks: ['abc'],
  rationale: 'Airway/breathing/circulation always comes first.',
  expected_value: null,
  tolerance: null,
  answer_unit: null,
  rounding_note: null,
  status: 'flagged',
  safety_flags: ['low_confidence'],
  content_hash: 'abc123',
  created_at: '2026-08-20T00:00:00Z',
  updated_at: '2026-08-20T00:00:00Z',
  question_options: [
    {
      id: 'o-1',
      ordinal: 1,
      option_text: 'Call the provider',
      is_correct: false,
      correct_position: null,
      rationale: 'Wrong: assess first.',
    },
    {
      id: 'o-2',
      ordinal: 2,
      option_text: 'Assess vital signs',
      is_correct: true,
      correct_position: null,
      rationale: 'Correct: ABC.',
    },
  ],
};

describe('fetchReviewQueue', () => {
  it('requests the review queue action and returns the questions', async () => {
    const { client, invoke } = functionsClient({ data: { questions: [sampleQuestion] } });
    const result = await fetchReviewQueue(client);
    expect(result).toEqual([sampleQuestion]);
    expect(invoke).toHaveBeenCalledWith('content-review', { body: { action: 'list' } });
  });

  it('forwards optional filters', async () => {
    const { client, invoke } = functionsClient({ data: { questions: [] } });
    await fetchReviewQueue(client, { status: ['flagged'], courseId: 'course-1', limit: 10 });
    expect(invoke).toHaveBeenCalledWith('content-review', {
      body: { action: 'list', status: ['flagged'], course_id: 'course-1', limit: 10 },
    });
  });

  it('maps a 403 to a reviewer-facing access message', async () => {
    const { client } = functionsClient({ error: { context: { status: 403 } } });
    await expect(fetchReviewQueue(client)).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/reviewer access/i),
    });
  });

  it('maps a 401 to a session-expired message', async () => {
    const { client } = functionsClient({ error: { context: { status: 401 } } });
    await expect(fetchReviewQueue(client)).rejects.toMatchObject({
      status: 401,
      message: expect.stringMatching(/session has expired/i),
    });
  });

  it('maps an unknown failure to a generic unavailable message', async () => {
    const { client } = functionsClient({ error: { context: {} } });
    await expect(fetchReviewQueue(client)).rejects.toMatchObject({
      message: expect.stringMatching(/unavailable/i),
    });
  });
});

describe('decideReviewQuestion', () => {
  it('sends the decision with no edits', async () => {
    const { client, invoke } = functionsClient({ data: { ok: true } });
    await decideReviewQuestion(client, 'q-1', { decision: 'approve' });
    expect(invoke).toHaveBeenCalledWith('content-review', {
      body: { action: 'decide', question_id: 'q-1', decision: 'approve' },
    });
  });

  it('sends edits with no decision (edit-only save)', async () => {
    const { client, invoke } = functionsClient({ data: { ok: true } });
    await decideReviewQuestion(client, 'q-1', {
      edits: { stem: 'Updated stem text that is long enough to pass validation.' },
    });
    expect(invoke).toHaveBeenCalledWith('content-review', {
      body: {
        action: 'decide',
        question_id: 'q-1',
        edits: { stem: 'Updated stem text that is long enough to pass validation.' },
      },
    });
  });

  it('sends both edits and a decision together', async () => {
    const { client, invoke } = functionsClient({ data: { ok: true } });
    await decideReviewQuestion(client, 'q-1', {
      decision: 'reject',
      edits: { options: [{ id: 'o-1', option_text: 'Revised option text' }] },
    });
    expect(invoke).toHaveBeenCalledWith('content-review', {
      body: {
        action: 'decide',
        question_id: 'q-1',
        decision: 'reject',
        edits: { options: [{ id: 'o-1', option_text: 'Revised option text' }] },
      },
    });
  });

  it('throws a reviewer-facing error on failure', async () => {
    const { client } = functionsClient({ error: { context: { status: 409 } } });
    await expect(
      decideReviewQuestion(client, 'q-1', { decision: 'approve' })
    ).rejects.toMatchObject({ status: 409 });
  });
});
