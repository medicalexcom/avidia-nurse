/**
 * Planner rules and thresholds — M13 (spec AJ-equivalent centralization).
 *
 * Every scheduling constant lives here, documented, so plan behavior is
 * inspectable and versioned. Bump PLANNER_RULES_VERSION when any rule
 * changes meaning. None of these numbers judge learning quality — they are
 * scheduling preferences and evidence gates.
 */

/** Version stamp persisted with every generated plan. */
export const PLANNER_RULES_VERSION = 1;

/** How many days ahead a plan covers (spec W: a simple upcoming view). */
export const DEFAULT_HORIZON_DAYS = 14;

/** Availability presets (spec C) — scheduling preferences, not judgments. */
export const AVAILABILITY_PRESETS = {
  light: 20,
  standard: 45,
  intensive: 90,
} as const;

/** Per-day availability bounds (minutes). */
export const MIN_DAILY_MINUTES = 0;
export const MAX_DAILY_MINUTES = 240;

/** Activity duration building blocks (minutes). */
export const TARGETED_PRACTICE_MINUTES = 15;
export const MISCONCEPTION_SLOT_MINUTES = 10;
export const MODE_CHALLENGE_MINUTES = 10;
export const COVERAGE_BLOCK_MINUTES = 10;
export const ENRICHMENT_MINUTES = 10;
export const SIMULATION_MINUTES = 20;
/** Due-review block: ~3 min per due concept, clamped to a sane block. */
export const REVIEW_MINUTES_PER_CONCEPT = 3;
export const MIN_REVIEW_BLOCK_MINUTES = 5;
export const MAX_REVIEW_BLOCK_MINUTES = 15;

/** Demand caps so one signal never floods the whole plan (spec J diversity). */
export const MAX_MISCONCEPTION_SLOTS_PER_COURSE = 2;
export const MAX_PRIORITY_SLOTS_PER_COURSE = 6;
export const MAX_REVIEW_BLOCKS_PER_COURSE = 2;
export const MAX_COVERAGE_BLOCKS_PER_COURSE = 3;
export const MAX_SIMULATIONS_PER_PLAN_PER_COURSE = 1;

/**
 * The M8 misconception multiplier at/above which the signal is active.
 * Mirrors the M9 constant — the VALUE is M8's; the planner defines no
 * second misconception detector.
 */
export const MISCONCEPTION_FACTOR_ACTIVE = 1.5;

/**
 * Simulation readiness gate (spec L: not when the student needs
 * foundational knowledge first): require this much assessed coverage
 * before a simulation slot is offered by the input assembler.
 */
export const SIMULATION_MIN_COVERAGE = 0.25;

/**
 * Higher-order gap gate (spec K): evidence-backed accuracy below this on
 * analysis/prioritization suggests scheduling a Priority Challenge. The
 * accuracy itself comes from M12 category rows (already evidence-gated).
 */
export const HIGHER_ORDER_GAP_ACCURACY = 0.6;

/** Exam-weighting shape for splitting a day across courses (spec F). */
export const COURSE_BASE_WEIGHT = 1;
export const COURSE_URGENCY_WEIGHT = 2;
export const COURSE_COVERAGE_BOOST = 0.5;

/** Reminder defaults (spec AE: conservative, opt-in). */
export const DEFAULT_REMINDER_HOUR = 18;
export const DEFAULT_QUIET_START_HOUR = 22;
export const DEFAULT_QUIET_END_HOUR = 7;
/** Exam reminders fire this many days before the exam (spec AF). */
export const EXAM_REMINDER_DAYS = [3, 1] as const;
/** How many days of reminders are scheduled ahead. */
export const REMINDER_HORIZON_DAYS = 7;
