/**
 * Study-mode and medication-category analytics — M12 (spec W/X).
 *
 * Groups the SAME attempt stream by the owning session's stored
 * session_type (the M10 modes share the M7 attempt pipeline — no separate
 * dataset, spec B). Accuracy shows only past MIN_MODE_ATTEMPTS (spec AJ).
 * The medication slice (spec X) filters attempts to medication-linked
 * concepts or numeric-calculation questions using stored fields only.
 */

import { MIN_CATEGORY_ATTEMPTS, MIN_MODE_ATTEMPTS } from './thresholds';
import type { AccuracySlice, AttemptRecord, ConceptRecord, SessionRecord } from './types';
import { accuracySlice } from './types';

/** The five M10 modes plus the M7/M9 session types, for honest grouping. */
export const MODE_IDS = [
  'rapid_response',
  'find_the_danger',
  'who_first',
  'medication_lab',
  'boss_battle',
] as const;
export type ModeId = (typeof MODE_IDS)[number];

export const MODE_LABELS: Record<ModeId, string> = {
  rapid_response: 'Rapid Response',
  find_the_danger: 'Find the Danger',
  who_first: 'Who First?',
  medication_lab: 'Medication Lab',
  boss_battle: 'Boss Battle',
};

export interface ModeAnalyticsRow {
  modeId: ModeId;
  label: string;
  sessionsStarted: number;
  sessionsCompleted: number;
  attempts: number;
  /** Present only once MIN_MODE_ATTEMPTS is met (spec W/AJ). */
  accuracy: AccuracySlice | null;
}

export interface MedicationAnalytics {
  attempts: number;
  /** Present only once MIN_CATEGORY_ATTEMPTS is met (spec X). */
  accuracy: AccuracySlice | null;
}

export function computeModeAnalytics(
  attempts: readonly AttemptRecord[],
  sessions: readonly SessionRecord[]
): ModeAnalyticsRow[] {
  return MODE_IDS.map((modeId) => {
    const modeSessions = sessions.filter((s) => s.sessionType === modeId);
    const modeAttempts = attempts.filter((a) => a.sessionType === modeId);
    const slice = accuracySlice(
      modeAttempts.filter((a) => a.isCorrect).length,
      modeAttempts.length
    );
    return {
      modeId,
      label: MODE_LABELS[modeId],
      sessionsStarted: modeSessions.length,
      sessionsCompleted: modeSessions.filter((s) => s.status === 'completed').length,
      attempts: modeAttempts.length,
      accuracy: modeAttempts.length >= MIN_MODE_ATTEMPTS ? slice : null,
    };
  });
}

/**
 * Medication-focused performance (spec X): attempts whose concept is
 * medication-typed or whose question is a numeric calculation.
 */
export function computeMedicationAnalytics(
  attempts: readonly AttemptRecord[],
  concepts: readonly ConceptRecord[]
): MedicationAnalytics {
  const medicationConceptIds = new Set(
    concepts.filter((c) => c.conceptType === 'medication').map((c) => c.conceptId)
  );
  const matching = attempts.filter(
    (a) =>
      (a.conceptId !== null && medicationConceptIds.has(a.conceptId)) ||
      a.questionType === 'numeric_calculation'
  );
  const slice = accuracySlice(matching.filter((a) => a.isCorrect).length, matching.length);
  return {
    attempts: matching.length,
    accuracy: matching.length >= MIN_CATEGORY_ATTEMPTS ? slice : null,
  };
}
