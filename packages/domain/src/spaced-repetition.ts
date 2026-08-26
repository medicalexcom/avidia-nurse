/**
 * Spaced-repetition scheduling types — Skill #4.
 *
 * Builds on Skills #1–#3 to schedule when a concept should next be reviewed.
 * Reuses the existing ConfidenceLevel used by the mastery engine.
 */

export type { ConfidenceLevel } from './questions';

import type { ConfidenceLevel } from './questions';

export type ReviewUrgency = 'due_now' | 'due_soon' | 'upcoming' | 'unlocked';

export interface ReviewAttempt {
  conceptId: string;
  correct: boolean;
  confidence: ConfidenceLevel | null;
  responseTimeMs: number | null;
  masteryBefore: number;
  masteryAfter: number;
  answeredAt: string;
}

export interface ReviewSchedule {
  conceptId: string;
  masteryLevel: number;
  reviewStage: number;
  dueAt: string | null;
  urgency: ReviewUrgency;
}
