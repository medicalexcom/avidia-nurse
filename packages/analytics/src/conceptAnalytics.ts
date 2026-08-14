/**
 * Per-concept analytics — M12 (spec F/H/I/M).
 *
 * State comes from M8's `masteryState`; misconception signals come from
 * M8's stored `misconceptionSeverity` against M8's own threshold — this
 * module interprets, it never re-derives (core principle). Needs-attention
 * membership requires EVIDENCE of a problem: unassessed concepts are never
 * listed as weak (spec H), and strengths require sufficient evidence
 * (spec I).
 */

import type { CognitiveLevel, MasteryState } from '@avidia/domain';
import { COGNITIVE_LEVELS } from '@avidia/domain';
import { MISCONCEPTION_SIGNAL_THRESHOLD, masteryState } from '@avidia/mastery';
import { classifyTrend } from './trend';
import {
  MAX_ATTENTION_ITEMS,
  MIN_CONCEPT_ATTEMPTS,
  MIN_HIGH_CONFIDENCE_ERRORS,
  MIN_STRENGTH_ATTEMPTS,
} from './thresholds';
import { splitWeekOverWeek } from './windows';
import type {
  AccuracySlice,
  AttemptRecord,
  AttentionReason,
  ConceptRecord,
  MasteryRecord,
  Trend,
} from './types';
import { accuracySlice } from './types';

export interface ConceptAnalytics {
  conceptId: string;
  canonicalName: string;
  conceptType: string;
  state: MasteryState;
  attemptsCount: number;
  /** Recent (last-14-day) accuracy, only once MIN_CONCEPT_ATTEMPTS met. */
  recentAccuracy: AccuracySlice | null;
  lastPracticedAt: string | null;
  nextReviewAt: string | null;
  trend: Trend;
  /** Accuracy per cognitive level, levels with zero attempts omitted. */
  byCognitiveLevel: Partial<Record<CognitiveLevel, AccuracySlice>>;
  /** M8 misconception severity crossed M8's own signal threshold. */
  misconceptionSignal: boolean;
  highConfidenceErrorCount: number;
  attentionReasons: AttentionReason[];
}

export interface ConceptAnalyticsResult {
  concepts: ConceptAnalytics[];
  /** Evidence-backed problems, worst first, capped (spec H). */
  needsAttention: ConceptAnalytics[];
  /** Evidence-backed strengths (spec I). */
  strengths: ConceptAnalytics[];
}

function attentionRank(reason: AttentionReason): number {
  const order: AttentionReason[] = [
    'misconception_signal',
    'high_confidence_errors',
    'low_mastery',
    'declining_trend',
    'due_for_review',
  ];
  return order.indexOf(reason);
}

export function computeConceptAnalytics(
  concepts: readonly ConceptRecord[],
  mastery: readonly MasteryRecord[],
  attempts: readonly AttemptRecord[],
  now: Date,
  timeZone: string
): ConceptAnalyticsResult {
  const masteryByConcept = new Map(mastery.map((m) => [m.conceptId, m.aggregate]));
  const attemptsByConcept = new Map<string, AttemptRecord[]>();
  for (const attempt of attempts) {
    if (attempt.conceptId === null) continue;
    const list = attemptsByConcept.get(attempt.conceptId);
    if (list) list.push(attempt);
    else attemptsByConcept.set(attempt.conceptId, [attempt]);
  }

  const rows: ConceptAnalytics[] = concepts.map((concept) => {
    const aggregate = masteryByConcept.get(concept.conceptId) ?? null;
    const state = masteryState(aggregate, now);
    const conceptAttempts = attemptsByConcept.get(concept.conceptId) ?? [];
    const { thisWeek, previousWeek } = splitWeekOverWeek(conceptAttempts, now, timeZone);
    const trend = classifyTrend(thisWeek, previousWeek).trend;

    const recentWindow = [...thisWeek, ...previousWeek];
    const recentAccuracy =
      recentWindow.length >= MIN_CONCEPT_ATTEMPTS
        ? accuracySlice(recentWindow.filter((a) => a.isCorrect).length, recentWindow.length)
        : null;

    const byCognitiveLevel: Partial<Record<CognitiveLevel, AccuracySlice>> = {};
    for (const level of COGNITIVE_LEVELS) {
      const atLevel = conceptAttempts.filter((a) => a.cognitiveLevel === level);
      if (atLevel.length > 0) {
        byCognitiveLevel[level] = accuracySlice(
          atLevel.filter((a) => a.isCorrect).length,
          atLevel.length
        );
      }
    }

    const highConfidenceErrorCount = conceptAttempts.filter(
      (a) => !a.isCorrect && (a.confidence === 'certain' || a.confidence === 'pretty_sure')
    ).length;
    const misconceptionSignal =
      aggregate !== null &&
      aggregate.attemptsCount >= MIN_CONCEPT_ATTEMPTS &&
      aggregate.misconceptionSeverity >= MISCONCEPTION_SIGNAL_THRESHOLD;

    const attentionReasons: AttentionReason[] = [];
    // Spec H: every reason requires EVIDENCE — unassessed never qualifies.
    if (aggregate !== null && aggregate.attemptsCount >= MIN_CONCEPT_ATTEMPTS) {
      if (misconceptionSignal) attentionReasons.push('misconception_signal');
      if (highConfidenceErrorCount >= MIN_HIGH_CONFIDENCE_ERRORS) {
        attentionReasons.push('high_confidence_errors');
      }
      if (state === 'needs_review') attentionReasons.push('low_mastery');
      if (trend === 'declining') attentionReasons.push('declining_trend');
      if (state === 'due_for_review') attentionReasons.push('due_for_review');
    }

    return {
      conceptId: concept.conceptId,
      canonicalName: concept.canonicalName,
      conceptType: concept.conceptType,
      state,
      attemptsCount: aggregate?.attemptsCount ?? 0,
      recentAccuracy,
      lastPracticedAt: aggregate?.lastAttemptAt ?? null,
      nextReviewAt: aggregate?.nextReviewAt ?? null,
      trend,
      byCognitiveLevel,
      misconceptionSignal,
      highConfidenceErrorCount,
      attentionReasons,
    };
  });

  const needsAttention = rows
    .filter((row) => row.attentionReasons.length > 0)
    .sort(
      (a, b) =>
        attentionRank(a.attentionReasons[0] ?? 'due_for_review') -
          attentionRank(b.attentionReasons[0] ?? 'due_for_review') ||
        a.canonicalName.localeCompare(b.canonicalName)
    )
    .slice(0, MAX_ATTENTION_ITEMS);

  const strengths = rows
    .filter(
      (row) =>
        row.state === 'strong' &&
        row.attemptsCount >= MIN_STRENGTH_ATTEMPTS &&
        row.attentionReasons.length === 0
    )
    .sort(
      (a, b) => b.attemptsCount - a.attemptsCount || a.canonicalName.localeCompare(b.canonicalName)
    );

  return { concepts: rows, needsAttention, strengths };
}
