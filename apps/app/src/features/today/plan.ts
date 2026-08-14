/**
 * Pure daily-session planning helpers — M9 (spec B/D/I/J/M/O/AB).
 *
 * Everything in this file is deterministic and side-effect free: no network,
 * no clock reads, no randomness beyond the seeded M8 selector it delegates
 * to. The screens call these helpers and render the result; none of the M8
 * mastery/priority arithmetic is duplicated here (spec C) — adaptation and
 * summaries consume SERVER-returned aggregates and the pure `@avidia/mastery`
 * ranking output.
 */

import type { StudyRecommendation, SelectableQuestion } from '@avidia/mastery';
import { buildAdaptiveQuestionOrder } from '@avidia/mastery';

import type { MasteryEcho, SessionPlanRow } from '../practice/practiceApi';
import type { ConceptMasteryRow, CourseAttemptRow } from '../study/studyApi';

// ---------------------------------------------------------------------------
// Durations → session composition (spec B/D)
// ---------------------------------------------------------------------------

/** The duration presets offered by START TODAY and quick sessions (spec B/N). */
export const SESSION_DURATION_MINUTES = [5, 10, 20, 45] as const;

/**
 * Planning estimate for one question including reading the rationale
 * (spec D). An estimate for COMPOSITION only — actual pace never shortens
 * scoring or rationale reading, and finishing "late" is not penalized
 * (spec I: no reward for rushing).
 */
export const ESTIMATED_SECONDS_PER_QUESTION = 75;

/** Bounds shared with the database (planned_question_count / plan position 1–50). */
export const MIN_SESSION_QUESTIONS = 3;
export const MAX_SESSION_QUESTIONS = 50;

/**
 * How many questions a session of `minutes` should plan (spec D): duration
 * divided by the per-question estimate, clamped to [3, 50], then capped by
 * the available pool. A small pool SHRINKS the session rather than blocking
 * it (spec W/X); zero pool returns zero and the caller shows an empty state.
 */
export function questionCountForDuration(minutes: number, poolSize: number): number {
  if (poolSize <= 0) return 0;
  const base = Math.round((minutes * 60) / ESTIMATED_SECONDS_PER_QUESTION);
  const clamped = Math.min(MAX_SESSION_QUESTIONS, Math.max(MIN_SESSION_QUESTIONS, base));
  return Math.min(clamped, poolSize);
}

/** "~N min left" estimate from the remaining question count (spec I). */
export function estimateRemainingMinutes(remainingCount: number): number {
  if (remainingCount <= 0) return 0;
  return Math.max(1, Math.round((remainingCount * ESTIMATED_SECONDS_PER_QUESTION) / 60));
}

// ---------------------------------------------------------------------------
// Resume: stored plan minus recorded attempts (spec O/AB)
// ---------------------------------------------------------------------------

/**
 * The question ids still to do, in stored-plan order (spec O): the persisted
 * plan minus questions already answered (from question_attempts — the single
 * source of answer truth) minus questions explicitly skipped (spec AB).
 * Pure set subtraction; nothing here can double-apply a mastery update.
 */
export function remainingPlanQuestionIds(
  plan: readonly SessionPlanRow[],
  answeredQuestionIds: ReadonlySet<string>
): string[] {
  return plan
    .filter((row) => row.skipped_at === null && !answeredQuestionIds.has(row.question_id))
    .map((row) => row.question_id);
}

// ---------------------------------------------------------------------------
// In-session adaptation (spec J) — delegated to the seeded M8 selector
// ---------------------------------------------------------------------------

/**
 * Re-order the REMAINING questions after new evidence arrived (spec J). The
 * ordering rules are entirely M8's `buildAdaptiveQuestionOrder`; this wrapper
 * only restricts the pool to the remaining items and derives the
 * deterministic seed from the session id and progress point, so a re-run
 * with identical inputs produces an identical order (spec AB). The stored
 * plan is untouched — it stays the resume baseline (ADR-0025).
 */
export function reorderRemainingQuestions(
  remaining: readonly SelectableQuestion[],
  ranked: readonly StudyRecommendation[],
  sessionId: string,
  answeredCount: number
): string[] {
  return buildAdaptiveQuestionOrder({
    questions: remaining,
    ranked,
    sessionSize: remaining.length,
    seed: `${sessionId}:${answeredCount}`,
  });
}

/**
 * Fold the server's post-attempt aggregate echo into the local mastery rows
 * (spec C/J): replace-or-insert the row for the echoed concept with the
 * database's numbers. No arithmetic happens here — the values come from the
 * transactional update inside `submit_question_attempt`.
 */
export function applyMasteryEcho(
  rows: readonly ConceptMasteryRow[],
  echo: MasteryEcho,
  answeredAt: string
): ConceptMasteryRow[] {
  const updated: ConceptMasteryRow = {
    concept_id: echo.concept_id,
    mastery: echo.mastery,
    attempts_count: echo.attempts_count,
    correct_count: echo.correct_count,
    misconception_severity: echo.misconception_severity,
    review_stage: echo.review_stage,
    last_attempt_at: answeredAt,
    next_review_at: echo.next_review_at,
    algorithm_version: echo.algorithm_version,
  };
  const others = rows.filter((row) => row.concept_id !== echo.concept_id);
  return [...others, updated];
}

/**
 * Append the just-recorded attempt to the local attempt list so snapshot
 * facts (recent error, seen questions) stay current mid-session without a
 * refetch. Mirrors what the database just wrote — not a second copy of truth.
 */
export function appendLocalAttempt(
  attempts: readonly CourseAttemptRow[],
  questionId: string,
  isCorrect: boolean,
  createdAt: string
): CourseAttemptRow[] {
  return [...attempts, { question_id: questionId, is_correct: isCorrect, created_at: createdAt }];
}

// ---------------------------------------------------------------------------
// Respectful remediation copy (spec L)
// ---------------------------------------------------------------------------

/**
 * Shown when the priority engine flags persistent confident errors
 * (misconception multiplier active). Deliberately gentle — never alarming
 * words like "dangerous" or "misconception" in student-facing copy (spec L).
 */
export const MISCONCEPTION_REVISIT_MESSAGE = "Let's revisit this concept from a different angle.";

/** The factor threshold at which the misconception multiplier is active. */
export const MISCONCEPTION_FACTOR_ACTIVE = 1.5;

/** Whether a recommendation's factors indicate the misconception signal. */
export function hasActiveMisconceptionFactor(
  recommendation: StudyRecommendation | undefined
): boolean {
  return (
    recommendation !== undefined &&
    recommendation.factors.misconceptionMultiplier >= MISCONCEPTION_FACTOR_ACTIVE
  );
}

// ---------------------------------------------------------------------------
// Completion summary (spec M) — honest counts, no fake precision
// ---------------------------------------------------------------------------

/** One answered activity, as recorded during the session. */
export interface SessionActivityRecord {
  questionId: string;
  conceptId: string | null;
  isCorrect: boolean;
  /** Signed mastery change the SERVER reported for this attempt, or null. */
  masteryDelta: number | null;
}

export interface SessionSummary {
  answeredCount: number;
  correctCount: number;
  skippedCount: number;
  /** Unique concept ids the session touched. */
  conceptsReviewed: string[];
  /** Concepts whose summed server-reported delta was positive. */
  conceptsImproved: string[];
  /** Concepts that were due for review at session start AND got practiced. */
  dueReviewsCompleted: number;
  /** Highest-priority concepts still waiting (latest ranking, top slice). */
  remainingPriorities: StudyRecommendation[];
  /** The single recommended next step, or null when nothing is ranked. */
  recommendedNext: StudyRecommendation | null;
}

/**
 * Assemble the completion summary from session records + the latest ranking
 * (spec M). Everything is a count or a concept reference — no percentages,
 * scores, or predictions are computed here (spec M "no fake precision").
 * Useful even when the student stopped early (spec D): it summarizes what
 * actually happened, not what was planned.
 */
export function buildSessionSummary(input: {
  records: readonly SessionActivityRecord[];
  skippedCount: number;
  /** Concept ids whose next_review_at was due when the session started. */
  dueConceptIdsAtStart: ReadonlySet<string>;
  /** rankConcepts output computed AFTER the last attempt. */
  latestRanked: readonly StudyRecommendation[];
  maxRemainingPriorities?: number;
}): SessionSummary {
  const { records, skippedCount, dueConceptIdsAtStart, latestRanked } = input;
  const maxRemaining = input.maxRemainingPriorities ?? 3;

  const deltaByConcept = new Map<string, number>();
  const reviewed: string[] = [];
  for (const record of records) {
    if (record.conceptId === null) continue;
    if (!reviewed.includes(record.conceptId)) reviewed.push(record.conceptId);
    if (record.masteryDelta !== null) {
      deltaByConcept.set(
        record.conceptId,
        (deltaByConcept.get(record.conceptId) ?? 0) + record.masteryDelta
      );
    }
  }

  const improved = reviewed.filter((conceptId) => (deltaByConcept.get(conceptId) ?? 0) > 0);
  const dueCompleted = reviewed.filter((conceptId) => dueConceptIdsAtStart.has(conceptId)).length;

  const touched = new Set(reviewed);
  const remainingPriorities = latestRanked
    .filter((rec) => !touched.has(rec.conceptId))
    .slice(0, maxRemaining);

  return {
    answeredCount: records.length,
    correctCount: records.filter((record) => record.isCorrect).length,
    skippedCount,
    conceptsReviewed: reviewed,
    conceptsImproved: improved,
    dueReviewsCompleted: dueCompleted,
    remainingPriorities,
    recommendedNext: latestRanked[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Due reviews (spec R) — read M8's schedule, never a second scheduler
// ---------------------------------------------------------------------------

/** Concept ids whose stored next_review_at is due at `now` (spec R). */
export function dueReviewConceptIds(rows: readonly ConceptMasteryRow[], now: Date): Set<string> {
  const due = new Set<string>();
  for (const row of rows) {
    if (row.next_review_at !== null && Date.parse(row.next_review_at) <= now.getTime()) {
      due.add(row.concept_id);
    }
  }
  return due;
}
