/**
 * Mastery and study-scheduling domain vocabulary — M8 (spec B/C/Q/S/T).
 *
 * Pure shared vocabulary only: the student-facing mastery states, the
 * recommendation reason codes and their honest labels. The mastery math,
 * review scheduling, priority model and recommendation engine live in
 * `@avidia/mastery`; screens consume these constants and never re-declare
 * them.
 */

/**
 * Student-facing mastery states (spec B/C/Q).
 *
 * The internal mastery score is a normalized 0–1 signal; students only ever
 * see these coarse states — never a percentage — because the score is an
 * evidence-weighted estimate, not a measurement (spec AG: no fake
 * precision).
 *
 *   - unassessed      no evidence yet — explicitly NOT "0% mastery" (spec C:
 *                     absence of evidence must never read as failure)
 *   - needs_review    evidence points to a gap
 *   - developing      evidence is building but not yet consistent
 *   - strong          repeated consistent evidence of understanding
 *   - due_for_review  previously assessed but the review window has passed —
 *                     an URGENCY overlay, not an erasure of prior evidence
 *                     (spec J: mastery evidence and review urgency are
 *                     separate concepts)
 *
 * Wording is deliberately non-stigmatizing (spec Q): "needs review", never
 * "failing" or "weak".
 */
export const MASTERY_STATES = [
  'unassessed',
  'needs_review',
  'developing',
  'strong',
  'due_for_review',
] as const;

export type MasteryState = (typeof MASTERY_STATES)[number];

export const MASTERY_STATE_LABELS: Record<MasteryState, string> = {
  unassessed: 'New',
  needs_review: 'Needs review',
  developing: 'Developing',
  strong: 'Strong',
  due_for_review: 'Due for review',
};

/** Short student-facing explanation of what each state means. */
export const MASTERY_STATE_DESCRIPTIONS: Record<MasteryState, string> = {
  unassessed: "You haven't practiced this yet.",
  needs_review: 'Recent practice suggests this needs another look.',
  developing: "You're building this — keep practicing.",
  strong: "You've shown consistent understanding here.",
  due_for_review: "It's been a while — a quick review will keep this fresh.",
};

export function isMasteryState(value: string): value is MasteryState {
  return (MASTERY_STATES as readonly string[]).includes(value);
}

/**
 * Recommendation reason codes (spec S/T): every study recommendation carries
 * the machine-readable reasons it was chosen, and the UI renders them as
 * plain language. Explainability comes from these codes — never from an LLM
 * narrating a guess (spec T).
 *
 *   - unassessed           no evidence for this concept yet
 *   - low_mastery          evidence points to a gap
 *   - review_due           the spaced-review window has passed
 *   - exam_soon            an upcoming exam makes this timely
 *   - recent_error         a recent incorrect answer, weighted higher when
 *                          answered with high confidence (spec R:
 *                          misconception signal, not an AI diagnosis)
 *   - high_course_emphasis this concept carries high emphasis in the course
 *                          materials (M6 signal, spec N — never an exam
 *                          prediction)
 *   - question_supply_low  the question bank for this concept is thin, so
 *                          variety will be limited (spec Y — an honest
 *                          limitation note, never a trigger to call an AI
 *                          provider)
 */
export const RECOMMENDATION_REASONS = [
  'unassessed',
  'low_mastery',
  'review_due',
  'exam_soon',
  'recent_error',
  'high_course_emphasis',
  'question_supply_low',
] as const;

export type RecommendationReason = (typeof RECOMMENDATION_REASONS)[number];

export const RECOMMENDATION_REASON_LABELS: Record<RecommendationReason, string> = {
  unassessed: "You haven't practiced this yet",
  low_mastery: 'Recent answers suggest a gap here',
  review_due: 'Due for a spaced review',
  exam_soon: 'Relevant to an upcoming exam',
  recent_error: 'You recently missed a question on this',
  high_course_emphasis: 'Heavily emphasized in your course materials',
  question_supply_low: 'Limited questions available for this topic',
};

export function isRecommendationReason(value: string): value is RecommendationReason {
  return (RECOMMENDATION_REASONS as readonly string[]).includes(value);
}
