/**
 * Study recommendation engine — M8 (spec S/T/X/Y/AH/AN).
 *
 * `getStudyRecommendation` is the single clean entry point (spec AH): the UI
 * passes owner-readable data in and renders what comes out; it never
 * calculates priorities itself. Pure and deterministic — ties break by
 * concept id so identical inputs always produce identical output (spec AB).
 * Explainability comes from reason codes (spec T), never from an LLM.
 */

import type { RecommendationReason, MasteryState } from '@avidia/domain';
import {
  HIGH_EMPHASIS_THRESHOLD,
  QUESTION_SUPPLY_LOW_THRESHOLD,
  RECENT_ERROR_WINDOW_HOURS,
  STATE_THRESHOLDS,
  TARGET_CHARACTERISTICS,
} from './config';
import { examRelevanceFactor, type UpcomingExam } from './examUrgency';
import { priorityScore, type PriorityFactors } from './priority';
import { masteryState } from './states';
import type { MasteryAggregate } from './update';

export interface ConceptSnapshot {
  conceptId: string;
  /** Aggregate evidence, or null when unassessed (spec C). */
  aggregate: MasteryAggregate | null;
  /** M6 emphasis normalized to [0, 1] (spec N). */
  normalizedEmphasis: number;
  /** Correct evidence exists at application-or-higher cognitive level. */
  hasHigherOrderCorrect: boolean;
  /** ISO timestamp of the most recent INCORRECT attempt, or null. */
  lastIncorrectAt: string | null;
  /** Count of active questions for this concept the student has NOT yet
   * answered in the current context (spec Y supply signal). */
  unseenQuestionCount: number;
}

export interface RecommendationInput {
  concepts: readonly ConceptSnapshot[];
  exams: readonly UpcomingExam[];
  /** Student's IANA timezone for exam-day math (spec AI). */
  timeZone: string;
  now: Date;
}

export interface RecommendedQuestionCharacteristics {
  difficulties: readonly string[];
  cognitiveLevels: readonly string[];
}

export interface StudyRecommendation {
  conceptId: string;
  priority: number;
  factors: PriorityFactors;
  masteryState: MasteryState;
  reasonCodes: RecommendationReason[];
  recommendedQuestionCharacteristics: RecommendedQuestionCharacteristics;
  nextReviewAt: string | null;
  /** The exam driving EXAM_SOON, when present. */
  urgentExamId: string | null;
}

/** Mastery-band → target question characteristics (spec U/X). */
export function targetCharacteristics(
  aggregate: MasteryAggregate | null
): RecommendedQuestionCharacteristics {
  if (aggregate === null || aggregate.attemptsCount === 0) return TARGET_CHARACTERISTICS.low;
  if (aggregate.mastery < STATE_THRESHOLDS.NEEDS_REVIEW_BELOW) return TARGET_CHARACTERISTICS.low;
  if (aggregate.mastery < STATE_THRESHOLDS.STRONG_AT) return TARGET_CHARACTERISTICS.mid;
  return TARGET_CHARACTERISTICS.high;
}

/** Score + explain one concept (exported for the dashboard's grouped view). */
export function scoreConcept(
  concept: ConceptSnapshot,
  exams: readonly UpcomingExam[],
  timeZone: string,
  now: Date
): StudyRecommendation {
  const { factor: examRelevance, urgentExamId } = examRelevanceFactor(
    concept.conceptId,
    exams,
    now,
    timeZone
  );
  const { score, factors } = priorityScore({
    aggregate: concept.aggregate,
    examRelevance,
    normalizedEmphasis: concept.normalizedEmphasis,
    hasHigherOrderCorrect: concept.hasHigherOrderCorrect,
    now,
  });
  const state = masteryState(concept.aggregate, now);

  const reasons: RecommendationReason[] = [];
  if (state === 'unassessed') reasons.push('unassessed');
  if (concept.aggregate !== null && concept.aggregate.attemptsCount > 0) {
    if (concept.aggregate.mastery < STATE_THRESHOLDS.NEEDS_REVIEW_BELOW) {
      reasons.push('low_mastery');
    }
    if (state === 'due_for_review') reasons.push('review_due');
    if (
      concept.lastIncorrectAt !== null &&
      now.getTime() - Date.parse(concept.lastIncorrectAt) <= RECENT_ERROR_WINDOW_HOURS * 3600_000
    ) {
      reasons.push('recent_error');
    }
  }
  if (urgentExamId !== null) reasons.push('exam_soon');
  if (concept.normalizedEmphasis >= HIGH_EMPHASIS_THRESHOLD) reasons.push('high_course_emphasis');
  if (concept.unseenQuestionCount < QUESTION_SUPPLY_LOW_THRESHOLD) {
    reasons.push('question_supply_low');
  }

  return {
    conceptId: concept.conceptId,
    priority: score,
    factors,
    masteryState: state,
    reasonCodes: reasons,
    recommendedQuestionCharacteristics: targetCharacteristics(concept.aggregate),
    nextReviewAt: concept.aggregate?.nextReviewAt ?? null,
    urgentExamId,
  };
}

/**
 * All concepts scored and ranked, highest priority first; deterministic
 * tie-break by concept id (spec AB). Concepts with zero unseen questions
 * still appear (with QUESTION_SUPPLY_LOW) — the engine reports supply
 * honestly and NEVER calls an AI provider to fix it (spec Y).
 */
export function rankConcepts(input: RecommendationInput): StudyRecommendation[] {
  return input.concepts
    .map((concept) => scoreConcept(concept, input.exams, input.timeZone, input.now))
    .sort((a, b) => b.priority - a.priority || a.conceptId.localeCompare(b.conceptId));
}

/**
 * The next-best study action (spec S/AH), or null when the course has no
 * concepts at all (spec AN: callers fall back to plain practice).
 */
export function getStudyRecommendation(input: RecommendationInput): StudyRecommendation | null {
  const ranked = rankConcepts(input);
  return ranked[0] ?? null;
}
