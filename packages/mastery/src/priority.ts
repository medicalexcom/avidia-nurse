/**
 * Study-priority model — M8 (spec J/N/O/P).
 *
 * priority = examRelevance × weakness × forgettingRisk × emphasisFactor ×
 *            misconceptionMultiplier × transferNeed
 *
 * Every factor is bounded and computed from named config constants (spec O).
 * MASTERY (evidence), REVIEW URGENCY (schedule) and STUDY PRIORITY (what
 * next) remain distinct quantities (spec P): mastery feeds `weakness`, the
 * schedule feeds `forgettingRisk`, and priority is the composition — none
 * overwrites another.
 */

import { PRIORITY, STATE_THRESHOLDS } from './config';
import type { MasteryAggregate } from './update';

export interface PriorityFactors {
  examRelevance: number;
  weakness: number;
  forgettingRisk: number;
  emphasisFactor: number;
  misconceptionMultiplier: number;
  transferNeed: number;
}

export interface PriorityInput {
  /** Aggregate evidence, or null when the concept is unassessed. */
  aggregate: MasteryAggregate | null;
  /** Exam-relevance factor from examRelevanceFactor() (≥ 1). */
  examRelevance: number;
  /** M6 emphasis normalized to [0, 1] (spec N). */
  normalizedEmphasis: number;
  /**
   * Whether correct evidence so far includes application-or-higher cognitive
   * levels (false ⇒ transfer still unproven, spec Blueprint transfer need).
   */
  hasHigherOrderCorrect: boolean;
  now: Date;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Forgetting risk in [0, 1] (spec J/K): the elapsed fraction of the current
 * review interval, floored so recently reviewed material keeps a small
 * baseline, saturating at 1 once the review is due or overdue.
 */
export function forgettingRisk(aggregate: MasteryAggregate, now: Date): number {
  if (aggregate.lastAttemptAt === null || aggregate.nextReviewAt === null) {
    return PRIORITY.UNASSESSED_FORGETTING_RISK;
  }
  const start = Date.parse(aggregate.lastAttemptAt);
  const due = Date.parse(aggregate.nextReviewAt);
  if (!(due > start)) return 1;
  const elapsed = (now.getTime() - start) / (due - start);
  return Math.max(PRIORITY.FORGETTING_RISK_FLOOR, clamp01(elapsed));
}

/** All six bounded factors for one concept (spec O — inspectable). */
export function priorityFactors(input: PriorityInput): PriorityFactors {
  const { aggregate } = input;
  if (aggregate === null || aggregate.attemptsCount === 0) {
    return {
      examRelevance: input.examRelevance,
      weakness: PRIORITY.UNASSESSED_WEAKNESS,
      forgettingRisk: PRIORITY.UNASSESSED_FORGETTING_RISK,
      emphasisFactor: 1 + PRIORITY.EMPHASIS_SCALE * clamp01(input.normalizedEmphasis),
      misconceptionMultiplier: 1,
      transferNeed: 1,
    };
  }
  const mastery = clamp01(aggregate.mastery);
  const developingOrBetter = mastery >= STATE_THRESHOLDS.NEEDS_REVIEW_BELOW;
  return {
    examRelevance: input.examRelevance,
    weakness: 1 - PRIORITY.WEAKNESS_MASTERY_SCALE * mastery,
    forgettingRisk: forgettingRisk(aggregate, input.now),
    emphasisFactor: 1 + PRIORITY.EMPHASIS_SCALE * clamp01(input.normalizedEmphasis),
    misconceptionMultiplier: 1 + clamp01(aggregate.misconceptionSeverity),
    transferNeed:
      developingOrBetter && !input.hasHigherOrderCorrect ? PRIORITY.TRANSFER_NEED_BONUS : 1,
  };
}

/** The deterministic priority score (spec O/AB). */
export function priorityScore(input: PriorityInput): { score: number; factors: PriorityFactors } {
  const factors = priorityFactors(input);
  const score =
    factors.examRelevance *
    factors.weakness *
    factors.forgettingRisk *
    factors.emphasisFactor *
    factors.misconceptionMultiplier *
    factors.transferNeed;
  return { score: Math.round(score * 1e6) / 1e6, factors };
}
