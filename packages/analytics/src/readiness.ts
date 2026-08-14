/**
 * Exam readiness — M12 (spec N/O/P/Q/R/S).
 *
 * Readiness is an INTERPRETABLE STATE with reasons, never a percentage,
 * never a grade prediction (spec Q/R). The two ingredients are kept
 * explicitly distinct (spec O):
 *
 *   COVERAGE — how much of the course has been assessed at all
 *   MASTERY  — how strong the assessed slice is (M8 states, spec N)
 *
 * High accuracy on 30% of the course is NOT readiness (synthetic student B,
 * spec AS): the coverage gates in thresholds.ts block 'on_track'/'strong'
 * regardless of mastery share. Sparse total evidence forces LOW confidence
 * wording (spec P). Exam focus (spec S) comes from M8's `rankConcepts` —
 * M12 does not own a priority algorithm.
 *
 * Scope limitation, stated honestly (spec M of M8, carried forward): no
 * exam→concept mapping exists in the schema, so readiness is computed
 * course-wide against the next upcoming exam.
 */

import { calendarDaysBetween } from '@avidia/domain';
import {
  rankConcepts,
  type ConceptSnapshot,
  type StudyRecommendation,
  type UpcomingExam,
} from '@avidia/mastery';
import { computeDistribution } from './distribution';
import {
  ASSESSED_COVERAGE_FOR_ON_TRACK,
  ASSESSED_COVERAGE_FOR_STRONG,
  MIN_READINESS_ATTEMPTS,
  NEEDS_REVIEW_SHARE_BLOCKING_STRONG,
  STRONG_SHARE_FOR_ON_TRACK,
  STRONG_SHARE_FOR_STRONG,
} from './thresholds';
import type { AttemptRecord, ConceptRecord, ExamRecord, MasteryRecord } from './types';

export type ReadinessState = 'early' | 'building' | 'on_track' | 'strong';

export const READINESS_LABELS: Record<ReadinessState, string> = {
  early: 'Early days',
  building: 'Building',
  on_track: 'On track',
  strong: 'Strong position',
};

export type ReadinessReason =
  | 'no_evidence_yet'
  | 'sparse_evidence'
  | 'low_coverage'
  | 'coverage_growing'
  | 'strong_share_low'
  | 'strong_share_solid'
  | 'needs_review_share_high'
  | 'broad_coverage'
  | 'consistent_strength';

export const READINESS_REASON_LABELS: Record<ReadinessReason, string> = {
  no_evidence_yet: "You haven't practiced in this course yet",
  sparse_evidence: 'Still limited evidence — this picture is low-confidence',
  low_coverage: 'Most course concepts are still unassessed',
  coverage_growing: "You've assessed a growing share of the course",
  strong_share_low: 'Few assessed concepts are strong yet',
  strong_share_solid: 'A solid share of assessed concepts are strong',
  needs_review_share_high: 'Several assessed concepts need review',
  broad_coverage: "You've practiced across most of the course",
  consistent_strength: 'Strong evidence across most assessed concepts',
};

export interface ExamReadiness {
  /** The exam being described, or null when none is upcoming. */
  exam: ExamRecord | null;
  daysUntilExam: number | null;
  state: ReadinessState;
  reasons: ReadinessReason[];
  /** True when total evidence is below MIN_READINESS_ATTEMPTS (spec P). */
  lowConfidence: boolean;
  /** COVERAGE: assessed fraction of course concepts, or null (spec O). */
  assessedCoverage: number | null;
  /** MASTERY: strong fraction OF ASSESSED concepts, or null (spec N). */
  strongShareOfAssessed: number | null;
  needsReviewShareOfAssessed: number | null;
  /** M8-ranked focus list for this exam window (spec S), capped. */
  focus: StudyRecommendation[];
}

/** The next exam at or after `now`, by exam time then id (deterministic). */
export function nextUpcomingExam(
  exams: readonly ExamRecord[],
  now: Date,
  timeZone: string
): ExamRecord | null {
  const upcoming = exams
    .filter((exam) => {
      const at = Date.parse(exam.examAt);
      return !Number.isNaN(at) && calendarDaysBetween(now, new Date(at), timeZone) >= 0;
    })
    .sort(
      (a, b) => Date.parse(a.examAt) - Date.parse(b.examAt) || a.examId.localeCompare(b.examId)
    );
  return upcoming[0] ?? null;
}

export function computeExamReadiness(
  concepts: readonly ConceptRecord[],
  mastery: readonly MasteryRecord[],
  attempts: readonly AttemptRecord[],
  exams: readonly ExamRecord[],
  now: Date,
  timeZone: string,
  focusLimit = 3
): ExamReadiness {
  const exam = nextUpcomingExam(exams, now, timeZone);
  const daysUntilExam =
    exam === null ? null : calendarDaysBetween(now, new Date(Date.parse(exam.examAt)), timeZone);

  const dist = computeDistribution(concepts, mastery, now);
  const assessed = dist.assessedConcepts;
  const strongShare = assessed > 0 ? dist.distribution.strong / assessed : null;
  const needsReviewShare = assessed > 0 ? dist.distribution.needs_review / assessed : null;
  const coverage = dist.assessedCoverage;
  const totalAttempts = attempts.length;
  const lowConfidence = totalAttempts < MIN_READINESS_ATTEMPTS;

  const reasons: ReadinessReason[] = [];
  let state: ReadinessState;
  if (totalAttempts === 0 || assessed === 0 || coverage === null) {
    state = 'early';
    reasons.push('no_evidence_yet');
  } else if (lowConfidence || coverage < ASSESSED_COVERAGE_FOR_ON_TRACK) {
    // Spec O/Q: low coverage caps readiness no matter how strong the slice.
    state = 'building';
    if (lowConfidence) reasons.push('sparse_evidence');
    if (coverage < ASSESSED_COVERAGE_FOR_ON_TRACK) reasons.push('low_coverage');
    if ((strongShare ?? 0) >= STRONG_SHARE_FOR_ON_TRACK) reasons.push('strong_share_solid');
  } else if (
    coverage >= ASSESSED_COVERAGE_FOR_STRONG &&
    (strongShare ?? 0) >= STRONG_SHARE_FOR_STRONG &&
    (needsReviewShare ?? 0) <= NEEDS_REVIEW_SHARE_BLOCKING_STRONG
  ) {
    state = 'strong';
    reasons.push('broad_coverage', 'consistent_strength');
  } else if ((strongShare ?? 0) >= STRONG_SHARE_FOR_ON_TRACK) {
    state = 'on_track';
    reasons.push('coverage_growing', 'strong_share_solid');
    if ((needsReviewShare ?? 0) > NEEDS_REVIEW_SHARE_BLOCKING_STRONG) {
      reasons.push('needs_review_share_high');
    }
  } else {
    state = 'building';
    reasons.push('coverage_growing', 'strong_share_low');
    if ((needsReviewShare ?? 0) > NEEDS_REVIEW_SHARE_BLOCKING_STRONG) {
      reasons.push('needs_review_share_high');
    }
  }

  // Exam focus via M8's engine (spec S: never another priority algorithm).
  const masteryByConcept = new Map(mastery.map((m) => [m.conceptId, m.aggregate]));
  const maxEmphasis = Math.max(1, ...concepts.map((c) => c.emphasisScore));
  const lastIncorrectByConcept = new Map<string, string>();
  const higherOrderCorrect = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.conceptId === null) continue;
    if (!attempt.isCorrect) {
      const prev = lastIncorrectByConcept.get(attempt.conceptId);
      if (prev === undefined || attempt.createdAt > prev) {
        lastIncorrectByConcept.set(attempt.conceptId, attempt.createdAt);
      }
    } else if (
      attempt.cognitiveLevel === 'application' ||
      attempt.cognitiveLevel === 'analysis' ||
      attempt.cognitiveLevel === 'prioritization'
    ) {
      higherOrderCorrect.add(attempt.conceptId);
    }
  }
  const snapshots: ConceptSnapshot[] = concepts.map((concept) => ({
    conceptId: concept.conceptId,
    aggregate: masteryByConcept.get(concept.conceptId) ?? null,
    normalizedEmphasis: Math.min(1, Math.max(0, concept.emphasisScore / maxEmphasis)),
    hasHigherOrderCorrect: higherOrderCorrect.has(concept.conceptId),
    lastIncorrectAt: lastIncorrectByConcept.get(concept.conceptId) ?? null,
    // Supply is not this layer's concern; a neutral positive count keeps the
    // supply-low reason out of readiness focus (M8 renders it elsewhere).
    unseenQuestionCount: Number.MAX_SAFE_INTEGER,
  }));
  const upcoming: UpcomingExam[] =
    exam === null ? [] : [{ examId: exam.examId, examAt: exam.examAt }];
  const focus = rankConcepts({ concepts: snapshots, exams: upcoming, timeZone, now }).slice(
    0,
    focusLimit
  );

  return {
    exam,
    daysUntilExam,
    state,
    reasons,
    lowConfidence,
    assessedCoverage: coverage,
    strongShareOfAssessed: strongShare,
    needsReviewShareOfAssessed: needsReviewShare,
    focus,
  };
}
