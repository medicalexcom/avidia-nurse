/**
 * Planner input/output shapes — M13.
 *
 * The engine consumes STRUCTURED data the app assembles from the
 * authoritative engines (M8 recommendations, M12 coverage/readiness,
 * M10 mode eligibility, M11 case availability) plus student availability.
 * It never recomputes mastery, priority, urgency, or readiness (core
 * principle: M13 is not another mastery engine).
 */

import type { StudyRecommendation } from '@avidia/mastery';

// ---------------------------------------------------------------------------
// Availability (spec B/C)
// ---------------------------------------------------------------------------

export type AvailabilityPreset = 'light' | 'standard' | 'intensive' | 'custom';

/**
 * Minutes available per weekday, indexed Sunday=0 … Saturday=6 (matching
 * JavaScript's Date#getDay). 0 means "no study planned that day".
 */
export type WeekdayMinutes = readonly [number, number, number, number, number, number, number];

export interface AvailabilityConfig {
  preset: AvailabilityPreset;
  minutesByWeekday: WeekdayMinutes;
}

// ---------------------------------------------------------------------------
// Per-course planner input (spec E-M) — all course-scoped (spec G)
// ---------------------------------------------------------------------------

export interface PlannerExam {
  examId: string;
  courseId: string;
  title: string;
  /** UTC instant (ISO). */
  examAt: string;
}

export interface PlannerCourseInput {
  courseId: string;
  courseTitle: string;
  /** M8 ranked recommendations for THIS course — already exam-aware. */
  recommendations: readonly StudyRecommendation[];
  /** Concept ids whose stored next_review_at is due (M8 schedule). */
  dueReviewConceptIds: readonly string[];
  /** Concept ids with no mastery evidence yet (UNASSESSED ≠ WEAK, spec I). */
  unassessedConceptIds: readonly string[];
  /** Display names so plan items can be explained. */
  conceptNames: Readonly<Record<string, string>>;
  /** M12 assessed coverage fraction, or null when unknown. */
  assessedCoverage: number | null;
  /**
   * M12 evidence-backed signal that analysis/prioritization accuracy lags
   * (spec K). False when evidence is insufficient.
   */
  higherOrderGap: boolean;
  /** M10 mode ids currently eligible for this course. */
  eligibleModes: readonly string[];
  /**
   * True when an M11 case exists AND the foundation gate passed
   * (assembler applies SIMULATION_MIN_COVERAGE — spec L).
   */
  simulationAvailable: boolean;
  /** Upcoming exams for THIS course. */
  exams: readonly PlannerExam[];
}

export interface PlannerInput {
  courses: readonly PlannerCourseInput[];
  availability: AvailabilityConfig;
  /** Student IANA timezone — all plan days are local calendar days. */
  timeZone: string;
  now: Date;
  /** Defaults to DEFAULT_HORIZON_DAYS. */
  horizonDays?: number;
}

// ---------------------------------------------------------------------------
// Plan output (spec D/N/O/P)
// ---------------------------------------------------------------------------

/** Planned activity types (spec M) — existing experiences only. */
export const PLAN_ACTIVITY_TYPES = [
  'start_today',
  'due_review',
  'targeted_practice',
  'rapid_response',
  'medication_lab',
  'priority_challenge',
  'find_the_danger',
  'boss_battle',
  'simulation',
] as const;

export type PlanActivityType = (typeof PLAN_ACTIVITY_TYPES)[number];

/** Deterministic reason codes (spec O). */
export const PLAN_REASON_CODES = [
  'exam_soon',
  'low_mastery',
  'review_due',
  'misconception_signal',
  'coverage_gap',
  'higher_order_gap',
  'clinical_practice',
  'keep_fresh',
] as const;

export type PlanReasonCode = (typeof PLAN_REASON_CODES)[number];

export interface PlanReason {
  code: PlanReasonCode;
  /** For exam_soon: the exam and local days away at that plan day. */
  examId?: string;
  daysUntilExam?: number;
}

/** Lifecycle states a persisted activity can be in (spec U). */
export const PLAN_ACTIVITY_STATUSES = [
  'planned',
  'started',
  'completed',
  'skipped',
  'superseded',
  'expired',
] as const;

export type PlanActivityStatus = (typeof PLAN_ACTIVITY_STATUSES)[number];

/** One planned activity as GENERATED (persistence adds id/status). */
export interface PlannedActivitySpec {
  courseId: string;
  courseTitle: string;
  type: PlanActivityType;
  /** Concept focus, when the activity targets one concept. */
  conceptId: string | null;
  conceptName: string | null;
  /** M10 mode id when the activity is a study mode. */
  modeId: string | null;
  minutes: number;
  reasons: readonly PlanReason[];
}

export interface PlanDay {
  /** Local calendar date, "YYYY-MM-DD" in the student's timezone. */
  date: string;
  /** JavaScript weekday (Sunday=0). */
  weekday: number;
  availableMinutes: number;
  plannedMinutes: number;
  activities: readonly PlannedActivitySpec[];
  /** Exams falling on this local day. */
  examIds: readonly string[];
}

export interface StudyPlanResult {
  days: readonly PlanDay[];
  horizonStart: string;
  horizonEnd: string;
  totalPlannedMinutes: number;
  /** Minutes of tier-1..5 demand that existed at generation time. */
  totalNeedMinutes: number;
  /** Capacity between now and the earliest exam (or whole horizon). */
  capacityMinutes: number;
  /** True when need exceeds capacity (spec P: show the constraint). */
  overCapacity: boolean;
  rulesVersion: number;
}

// ---------------------------------------------------------------------------
// Reminders (spec AA-AG) — pure instructions; the app schedules them
// ---------------------------------------------------------------------------

export interface ReminderPrefs {
  studyReminders: boolean;
  reviewReminders: boolean;
  examReminders: boolean;
  /** Local hour (0-23) reminders prefer to fire at. */
  reminderHour: number;
  /** Quiet hours [start, end) — wraps midnight when start > end. */
  quietStartHour: number;
  quietEndHour: number;
}

export interface ReminderInstruction {
  /** Deterministic id, e.g. "plan:2026-08-15" or "exam:<id>:3". */
  id: string;
  /** UTC instant the reminder should fire (ISO). */
  fireAt: string;
  title: string;
  body: string;
  /** In-app destination for the tap (validated allowlist app-side). */
  deepLink: string;
}
