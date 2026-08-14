/**
 * Pure mastery-update engine — M8 (spec D/E/F/G/H/I/AB).
 *
 * `updateMastery(previousState, performanceEvent) → newState` is a pure,
 * deterministic function: no database access, no clock reads, no
 * randomness. It is the TypeScript mirror of the PL/pgSQL implementation
 * inside `submit_question_attempt` (migration 0008); the contract tests pin
 * both to the same golden values so drift breaks CI.
 */

import type { CognitiveLevel, ConfidenceLevel, QuestionDifficulty } from '@avidia/domain';
import {
  CONFIDENCE_WEIGHT_CORRECT,
  CONFIDENCE_WEIGHT_INCORRECT,
  CONFIDENCE_WEIGHT_NEUTRAL,
  COGNITIVE_WEIGHT_CORRECT,
  COGNITIVE_WEIGHT_INCORRECT,
  DIFFICULTY_WEIGHT_CORRECT,
  DIFFICULTY_WEIGHT_INCORRECT,
  DROP_CAP,
  DROP_FLOOR,
  DROP_RATE,
  GAIN_CAP,
  GAIN_RATE,
  MASTERY_ALGORITHM_VERSION,
  MASTERY_MAX,
  MASTERY_MIN,
  MISCONCEPTION_DECAY_ON_CORRECT,
  MISCONCEPTION_INCREMENT,
  MISCONCEPTION_SIGNAL_THRESHOLD,
  RESPONSE_TIME_FACTOR,
  REVIEW_INTERVALS_HOURS,
  WEIGHT_RANGE,
} from './config';

/** Aggregate mastery evidence for one user × course × concept (spec A/AM). */
export interface MasteryAggregate {
  /** Normalized mastery evidence in [0, 1] (spec B). */
  mastery: number;
  /** Total scored attempts contributing to this aggregate. */
  attemptsCount: number;
  correctCount: number;
  /** Misconception severity in [0, 1] (spec R). */
  misconceptionSeverity: number;
  /** Spaced-review stage — index into REVIEW_INTERVALS_HOURS (spec K). */
  reviewStage: number;
  /** ISO timestamp of the last scored attempt, or null before any. */
  lastAttemptAt: string | null;
  /** ISO timestamp when the next spaced review is due, or null. */
  nextReviewAt: string | null;
}

/** The state of a concept before any evidence exists (spec C). */
export function initialAggregate(): MasteryAggregate {
  return {
    mastery: 0,
    attemptsCount: 0,
    correctCount: 0,
    misconceptionSeverity: 0,
    reviewStage: 0,
    lastAttemptAt: null,
    nextReviewAt: null,
  };
}

/** One scored attempt, as evidence (spec D). */
export interface PerformanceEvent {
  isCorrect: boolean;
  difficulty: QuestionDifficulty;
  cognitiveLevel: CognitiveLevel;
  /** Optional self-report; null when the student skipped the chips. */
  confidence: ConfidenceLevel | null;
  /** ISO timestamp of the attempt (passed in — the function never reads a clock). */
  answeredAt: string;
}

export interface MasteryUpdateResult {
  aggregate: MasteryAggregate;
  /** The signed mastery change actually applied (bounded, spec AK). */
  masteryDelta: number;
  /** Combined evidence weight after clamping — recorded for auditability (spec Z). */
  evidenceWeight: number;
  algorithmVersion: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Combined evidence weight for an event (spec F/G/H/I). Each factor is
 * documented in config.ts; the product is clamped to WEIGHT_RANGE so no
 * combination of metadata can make a single answer dominate.
 */
export function evidenceWeight(event: PerformanceEvent): number {
  const difficulty = event.isCorrect
    ? DIFFICULTY_WEIGHT_CORRECT[event.difficulty]
    : DIFFICULTY_WEIGHT_INCORRECT[event.difficulty];
  const cognitive = event.isCorrect
    ? COGNITIVE_WEIGHT_CORRECT[event.cognitiveLevel]
    : COGNITIVE_WEIGHT_INCORRECT;
  const confidence =
    event.confidence === null
      ? CONFIDENCE_WEIGHT_NEUTRAL
      : event.isCorrect
        ? CONFIDENCE_WEIGHT_CORRECT[event.confidence]
        : CONFIDENCE_WEIGHT_INCORRECT[event.confidence];
  return round6(
    clamp(
      difficulty * cognitive * confidence * RESPONSE_TIME_FACTOR,
      WEIGHT_RANGE.min,
      WEIGHT_RANGE.max
    )
  );
}

/**
 * Next misconception severity (spec R): confident errors accumulate,
 * correct answers decay, always clamped to [0, 1].
 */
export function nextMisconceptionSeverity(previous: number, event: PerformanceEvent): number {
  if (event.isCorrect) {
    return round6(clamp(previous * MISCONCEPTION_DECAY_ON_CORRECT, 0, 1));
  }
  const increment =
    event.confidence === 'certain'
      ? MISCONCEPTION_INCREMENT.certain
      : event.confidence === 'pretty_sure'
        ? MISCONCEPTION_INCREMENT.pretty_sure
        : MISCONCEPTION_INCREMENT.other_incorrect;
  return round6(clamp(previous + increment, 0, 1));
}

/** Whether accumulated severity constitutes a misconception signal (spec R). */
export function hasMisconceptionSignal(severity: number): boolean {
  return severity >= MISCONCEPTION_SIGNAL_THRESHOLD;
}

/**
 * Next spaced-review stage (spec K): correct advances one stage (except a
 * self-reported guess — luck earns no schedule relief); incorrect resets to
 * stage 0. Stages saturate at the last interval.
 */
export function nextReviewStage(previousStage: number, event: PerformanceEvent): number {
  if (!event.isCorrect) return 0;
  if (event.confidence === 'guessing') return Math.max(0, previousStage);
  return Math.min(previousStage + 1, REVIEW_INTERVALS_HOURS.length - 1);
}

/** The review interval (hours) for a stage — saturating lookup (spec K). */
export function reviewIntervalHours(stage: number): number {
  const idx = clamp(Math.trunc(stage), 0, REVIEW_INTERVALS_HOURS.length - 1);
  // idx is clamped into the (non-empty, constant) ladder's bounds.
  return REVIEW_INTERVALS_HOURS[idx]!;
}

/**
 * The pure mastery update (spec D/E). Deterministic: same inputs → same
 * outputs, no NaN/Infinity possible on valid inputs (spec AK invariants).
 */
export function updateMastery(
  previous: MasteryAggregate,
  event: PerformanceEvent
): MasteryUpdateResult {
  const weight = evidenceWeight(event);
  const m = clamp(previous.mastery, MASTERY_MIN, MASTERY_MAX);

  let delta: number;
  if (event.isCorrect) {
    delta = Math.min(GAIN_RATE * weight * (MASTERY_MAX - m), GAIN_CAP);
  } else {
    delta = -Math.min(DROP_RATE * weight * Math.max(m, DROP_FLOOR), DROP_CAP);
  }
  const mastery = round6(clamp(m + delta, MASTERY_MIN, MASTERY_MAX));
  const appliedDelta = round6(mastery - m);

  const stage = nextReviewStage(previous.reviewStage, event);
  const intervalMs = reviewIntervalHours(stage) * 3600_000;
  const answeredMs = Date.parse(event.answeredAt);
  const nextReviewAt = new Date(answeredMs + intervalMs).toISOString();

  return {
    aggregate: {
      mastery,
      attemptsCount: previous.attemptsCount + 1,
      correctCount: previous.correctCount + (event.isCorrect ? 1 : 0),
      misconceptionSeverity: nextMisconceptionSeverity(previous.misconceptionSeverity, event),
      reviewStage: stage,
      lastAttemptAt: new Date(answeredMs).toISOString(),
      nextReviewAt,
    },
    masteryDelta: appliedDelta,
    evidenceWeight: weight,
    algorithmVersion: MASTERY_ALGORITHM_VERSION,
  };
}
