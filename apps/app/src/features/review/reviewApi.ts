import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CognitiveLevel,
  PriorityFramework,
  QuestionDifficulty,
  QuestionSourceType,
  QuestionType,
} from '@avidia/domain';

/**
 * Content review — client for the `content-review` edge function.
 *
 * This is deliberately NOT a `@supabase/supabase-js` `.from(...)` call: the
 * answer-revealing columns (`rationale`, `is_correct`, `correct_position`,
 * option rationale) are excluded from the `authenticated` role's column
 * grants by design (ADR-0018 §3 "no answer leakage"), and no RLS policy
 * lets any client write `questions.status`. The edge function reaches those
 * columns with the service-role key, gated by `profiles.role = 'reviewer'`
 * (server-side — this module never trusts the client's own idea of its
 * role). See supabase/functions/content-review/index.ts.
 */

/** Only the two statuses the review queue ever surfaces (ADR-0018 §4). */
export type ReviewableStatus = 'generated' | 'flagged';

export interface ReviewOption {
  id: string;
  ordinal: number;
  option_text: string;
  is_correct: boolean;
  correct_position: number | null;
  rationale: string | null;
}

export interface ReviewQuestion {
  id: string;
  course_id: string;
  courses: { title: string } | null;
  concept_id: string | null;
  question_type: QuestionType;
  stem: string;
  difficulty: QuestionDifficulty;
  cognitive_level: CognitiveLevel;
  source_type: QuestionSourceType;
  generation_source: string;
  priority_frameworks: PriorityFramework[];
  rationale: string;
  expected_value: number | null;
  tolerance: number | null;
  answer_unit: string | null;
  rounding_note: string | null;
  status: ReviewableStatus;
  safety_flags: string[];
  content_hash: string;
  created_at: string;
  updated_at: string;
  question_options: ReviewOption[];
}

export interface ReviewApiError {
  status: number;
  message: string;
}

function toReviewApiError(error: unknown): ReviewApiError {
  const status = (error as { context?: { status?: number } })?.context?.status;
  if (status === 401) return { status, message: 'Your session has expired. Please sign in again.' };
  if (status === 403) return { status, message: 'You do not have reviewer access.' };
  return { status: status ?? 0, message: 'Content review is unavailable right now.' };
}

export async function fetchReviewQueue(
  client: SupabaseClient,
  options?: { status?: ReviewableStatus[]; courseId?: string; limit?: number }
): Promise<ReviewQuestion[]> {
  const { data, error } = await client.functions.invoke('content-review', {
    body: {
      action: 'list',
      ...(options?.status ? { status: options.status } : {}),
      ...(options?.courseId ? { course_id: options.courseId } : {}),
      ...(options?.limit ? { limit: options.limit } : {}),
    },
  });
  if (error) throw toReviewApiError(error);
  return (data as { questions: ReviewQuestion[] }).questions;
}

/**
 * Edits touch wording only — question stem, question/option rationale,
 * option text. Never `is_correct`/`correct_position` (see the edge
 * function's docstring for why that's out of scope for this first pass).
 */
export interface ReviewEdits {
  stem?: string;
  rationale?: string;
  options?: Array<{ id: string; option_text?: string; rationale?: string | null }>;
}

export type ReviewDecision = 'approve' | 'reject';

export async function decideReviewQuestion(
  client: SupabaseClient,
  questionId: string,
  params: { decision?: ReviewDecision; edits?: ReviewEdits }
): Promise<void> {
  const { error } = await client.functions.invoke('content-review', {
    body: {
      action: 'decide',
      question_id: questionId,
      ...(params.decision ? { decision: params.decision } : {}),
      ...(params.edits ? { edits: params.edits } : {}),
    },
  });
  if (error) throw toReviewApiError(error);
}
