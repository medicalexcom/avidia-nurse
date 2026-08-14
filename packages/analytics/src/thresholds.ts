/**
 * Centralized minimum-evidence thresholds — M12 (spec AJ).
 *
 * Every claim the analytics layer makes is gated on a named threshold from
 * this file, so "how much evidence before we say X" is documented, testable,
 * and changeable in exactly one place. When a gate is not met the layer says
 * "not enough data yet" — it never extrapolates (spec I: strengths require
 * sufficient evidence; spec P: uncertainty when data is sparse).
 */

/** Version stamp for the analytics interpretation rules (spec AB parity). */
export const ANALYTICS_RULES_VERSION = 1;

/**
 * Trend classification (spec G): each of the two comparison windows must
 * contain at least this many attempts, otherwise the trend is
 * 'insufficient'. Chosen so one lucky or unlucky question can never flip a
 * trend (spec G: do not overreact to a single question).
 */
export const MIN_TREND_ATTEMPTS_PER_WINDOW = 5;

/**
 * Trend classification (spec G): the accuracy delta (recent minus previous)
 * must move at least this much, in absolute fraction, to leave 'stable'.
 * With the 5-attempt minimum, a single question moves accuracy at most 0.2,
 * so 0.15 requires a real shift, not one answer.
 */
export const TREND_DELTA_THRESHOLD = 0.15;

/**
 * Per-concept recent accuracy and misconception-indicator claims require at
 * least this many attempts on the concept (spec F/M).
 */
export const MIN_CONCEPT_ATTEMPTS = 3;

/**
 * Calling a concept a STRENGTH additionally requires this many attempts —
 * more than the generic concept gate, because a strength claim invites the
 * student to deprioritize the topic (spec I).
 */
export const MIN_STRENGTH_ATTEMPTS = 4;

/**
 * Cognitive-level and difficulty breakdowns only show a row's accuracy once
 * the row has this many attempts; below it the row reports its count with
 * "not enough data yet" (spec J/K).
 */
export const MIN_CATEGORY_ATTEMPTS = 5;

/**
 * Confidence calibration requires this many confidence-tagged attempts
 * before any calibration statement is made (spec L).
 */
export const MIN_CALIBRATION_ATTEMPTS = 10;

/**
 * The "missed while feeling certain" attention/calibration signal requires
 * at least this many high-confidence incorrect answers — one slip while
 * certain is human, a repeat is a signal (spec L/M).
 */
export const MIN_HIGH_CONFIDENCE_ERRORS = 2;

/**
 * Exam readiness reports LOW CONFIDENCE (wide uncertainty) until at least
 * this many total scored attempts exist in the course (spec P).
 */
export const MIN_READINESS_ATTEMPTS = 20;

/**
 * Coverage gates for exam readiness (spec O/Q): readiness cannot be
 * 'on_track' below ASSESSED_COVERAGE_FOR_ON_TRACK nor 'strong' below
 * ASSESSED_COVERAGE_FOR_STRONG, no matter how high accuracy is on the
 * assessed slice — high accuracy on 30% of the course is not readiness
 * (synthetic student B, spec AS).
 */
export const ASSESSED_COVERAGE_FOR_ON_TRACK = 0.5;
export const ASSESSED_COVERAGE_FOR_STRONG = 0.75;

/**
 * Mastery-share gates for exam readiness (spec N): fraction of ASSESSED
 * concepts whose evidence band is strong.
 */
export const STRONG_SHARE_FOR_ON_TRACK = 0.4;
export const STRONG_SHARE_FOR_STRONG = 0.65;

/** Fraction of assessed concepts in needs_review that blocks 'strong'. */
export const NEEDS_REVIEW_SHARE_BLOCKING_STRONG = 0.15;

/**
 * Mode analytics show per-mode accuracy only after this many attempts in
 * the mode (spec W); medication-category rows use MIN_CATEGORY_ATTEMPTS.
 */
export const MIN_MODE_ATTEMPTS = 5;

/**
 * Simulation trend and dimension claims require this many COMPLETED
 * simulations; below it the layer lists sessions without trend language
 * (spec AA: adequate samples before trend claims).
 */
export const MIN_SIMULATION_SESSIONS_FOR_TREND = 3;

/** A per-dimension claim requires this many total possible points. */
export const MIN_DIMENSION_POSSIBLE_POINTS = 4;

/**
 * Error patterns (spec AB): a deterministic pattern must be backed by at
 * least this many matching incorrect attempts.
 */
export const MIN_PATTERN_ERRORS = 3;

/** How many needs-attention concepts / insights the overview surfaces. */
export const MAX_ATTENTION_ITEMS = 5;
export const MAX_INSIGHTS = 3;

/** Comparison windows in calendar days (spec C). */
export const WINDOW_DAYS_SHORT = 7;
export const WINDOW_DAYS_LONG = 30;
