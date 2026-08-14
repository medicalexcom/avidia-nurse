/**
 * Analytics input and output vocabulary — M12 (spec A/B).
 *
 * Inputs are thin, owner-readable row shapes lifted straight from the
 * existing M2–M11 tables (spec B: consume structured data, never duplicate
 * datasets). Outputs are the interpreted read-model shapes the UI renders
 * verbatim — the UI must never compute complex metrics from raw attempts
 * (spec A). Everything here is data; all computation lives in the sibling
 * modules and is pure and deterministic (spec AN: no LLM anywhere).
 */

import type {
  CognitiveLevel,
  ConfidenceLevel,
  MasteryState,
  QuestionDifficulty,
} from '@avidia/domain';
import type { MasteryAggregate } from '@avidia/mastery';

// ---------------------------------------------------------------------------
// Input rows (owner-readable via existing RLS; fetched bounded, spec AK)
// ---------------------------------------------------------------------------

/** One scored attempt joined with its question's stored metadata. */
export interface AttemptRecord {
  attemptId: string;
  questionId: string;
  /** The question's concept link, or null for unmapped questions. */
  conceptId: string | null;
  isCorrect: boolean;
  /** Self-reported confidence, or null when the student skipped the chips. */
  confidence: ConfidenceLevel | null;
  difficulty: QuestionDifficulty;
  cognitiveLevel: CognitiveLevel;
  questionType: string;
  /** The owning study session's type, or null if unknown. */
  sessionType: string | null;
  /** UTC ISO timestamp of the attempt (storage is UTC, spec AR). */
  createdAt: string;
}

/** One concept_mastery row — M8's authoritative aggregate for a concept. */
export interface MasteryRecord {
  conceptId: string;
  aggregate: MasteryAggregate;
}

/** Course concept metadata (M6). */
export interface ConceptRecord {
  conceptId: string;
  canonicalName: string;
  conceptType: string;
  /** M6 emphasis score (raw; normalized inside readiness/priority calls). */
  emphasisScore: number;
}

/** One study session row (M7/M9/M10). */
export interface SessionRecord {
  sessionId: string;
  sessionType: string;
  status: 'in_progress' | 'completed' | 'abandoned';
  startedAt: string;
  completedAt: string | null;
  /** Attempts recorded in this session (embedded count from the fetch). */
  attemptCount: number;
}

/** One upcoming or past exam (M2). */
export interface ExamRecord {
  examId: string;
  title: string;
  /** UTC instant of the exam. */
  examAt: string;
}

/** Per-dimension score slice from a completed simulation (M11). */
export interface SimulationDimensionRecord {
  dimension: string;
  label: string;
  earned: number;
  possible: number;
}

/**
 * One COMPLETED simulation session as returned by the
 * `get_simulation_analytics` RPC (migration 0013) — compact aggregates only,
 * never hidden case internals (spec Z).
 */
export interface SimulationRecord {
  sessionId: string;
  caseKey: string;
  caseTitle: string;
  outcomeKind: 'stabilized' | 'deteriorated' | 'complication' | 'timeout';
  outcomeLabel: string;
  completedAt: string;
  earned: number;
  possible: number;
  criticalMissedCount: number;
  unsafeActionCount: number;
  dimensions: SimulationDimensionRecord[];
}

/** Everything the analytics layer reads, in one bundle (spec A). */
export interface AnalyticsInput {
  attempts: AttemptRecord[];
  mastery: MasteryRecord[];
  concepts: ConceptRecord[];
  sessions: SessionRecord[];
  exams: ExamRecord[];
  simulations: SimulationRecord[];
  /** Student's IANA timezone for calendar math (spec AR). */
  timeZone: string;
  now: Date;
}

// ---------------------------------------------------------------------------
// Shared output vocabulary
// ---------------------------------------------------------------------------

/** Deterministic trend classification (spec G). */
export type Trend = 'improving' | 'stable' | 'declining' | 'insufficient';

export const TREND_LABELS: Record<Trend, string> = {
  improving: 'Improving',
  stable: 'Steady',
  declining: 'Slipping',
  insufficient: 'Not enough data yet',
};

/** A correct/total pair with the derived rate, or null rate when empty. */
export interface AccuracySlice {
  correct: number;
  total: number;
  /** Fraction in [0, 1], or null when total is 0 (never fake 0%, spec H). */
  accuracy: number | null;
}

export function accuracySlice(correct: number, total: number): AccuracySlice {
  return { correct, total, accuracy: total > 0 ? correct / total : null };
}

/** Mastery distribution across the five M8 states (spec E). */
export type MasteryDistribution = Record<MasteryState, number>;

/** Reasons a concept lands in "needs attention" (spec H — honest, coded). */
export type AttentionReason =
  | 'low_mastery'
  | 'due_for_review'
  | 'high_confidence_errors'
  | 'misconception_signal'
  | 'declining_trend';

export const ATTENTION_REASON_LABELS: Record<AttentionReason, string> = {
  low_mastery: 'Recent answers suggest a gap',
  due_for_review: 'Due for a spaced review',
  high_confidence_errors: 'Missed while feeling certain',
  misconception_signal: 'Pattern suggests a possible mix-up',
  declining_trend: 'Accuracy has slipped recently',
};

/** Where an insight's call-to-action should take the student (spec AD). */
export type InsightAction =
  | { kind: 'adaptive_session' }
  | { kind: 'practice_concept'; conceptId: string; conceptName: string }
  | { kind: 'study_mode'; modeId: string }
  | { kind: 'simulation' };

/** One actionable, deterministic insight (spec AC). */
export interface Insight {
  code: string;
  message: string;
  action: InsightAction | null;
}
