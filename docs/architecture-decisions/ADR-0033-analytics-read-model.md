# ADR-0033: Analytics as a pure read model over existing engines

- **Status:** Accepted
- **Date:** 2026-08-14
- **Milestone:** M12

## Context

M12 adds learning analytics, exam readiness, and performance intelligence.
The instruction's core principle is absolute: M12 IS NOT A SECOND MASTERY
ENGINE. M8 already owns mastery computation, review scheduling, study
priorities, and recommendations; M10/M11 already store mode sessions and
simulation scores. Analytics must interpret those outputs — never
recompute, never contradict, never persist derived state that can drift
out of sync. The UI must not compute complex metrics from raw attempts
(spec A), core analytics must work with zero AI configuration (spec AN),
and heavy courses must not ship lifetime history to the client (spec AK).

## Decision

### 1. One pure package, no stored analytics state

`@avidia/analytics` is a deterministic, side-effect-free read model:
`getCourseAnalytics(input) → CourseAnalytics`. The app fetches bounded,
owner-readable rows (attempts joined with stored question metadata,
`concept_mastery` aggregates, concepts, sessions, exams, simulation
aggregates), assembles one input bundle, and renders the result verbatim.
There are no new tables, no materialized views, no caches to invalidate —
analytics can never disagree with the data because it IS the data,
reinterpreted on read.

### 2. M8 remains the only authority

Mastery states come from M8's `masteryState`; the misconception signal
uses M8's own `MISCONCEPTION_SIGNAL_THRESHOLD`; the exam-focus list is
M8's `rankConcepts` output sliced to three — no second priority
algorithm exists (spec S). Where analytics needs a concept's state it
calls the engine; it never re-derives thresholds or schedules.

### 3. Centralized, versioned evidence thresholds (spec AJ)

Every minimum-evidence gate (trend windows, per-concept minimums,
calibration and readiness floors, simulation sample sizes, display caps)
lives in one documented module, `thresholds.ts`, stamped
`ANALYTICS_RULES_VERSION = 1`. Sections below their evidence floor say
"not enough data yet" — never NaN, never a fake 0%, and unassessed is
never labeled weak (spec H).

### 4. Simulation aggregates via one compact read-only RPC

`simulation_sessions.state/score/definition` are server-only columns
(migration 0011), so migration 0013 adds `get_simulation_analytics`: a
SECURITY DEFINER function returning per-completed-session aggregates for
the caller's own course — case metadata, snapshot-resolved outcome
kind/label, earned/possible, per-dimension points, and missed-critical /
unsafe COUNTS. The labeled lists and all hidden case internals (findings,
rules, dialogue) remain debrief-only. This avoids N debrief round-trips
(spec AK) without widening the redaction boundary (spec Z).

### 5. Calendar math in the student's timezone, memoized

All windows ("today", last 7/30 days, week-over-week) are calendar days
in the student's timezone computed with the same domain helpers the
countdown UIs use, so analytics and countdowns can never disagree —
including across DST transitions (spec AR). The per-attempt calendar-age
lookup is memoized (bounded cache) because Intl formatting is too slow to
call thousands of times per render; memoizing a pure function changes
nothing about determinism (spec AV).

## Consequences

- Analytics is trivially testable: golden synthetic students (spec AS),
  data-integrity fuzzing, and a performance bound run against the pure
  package with no database.
- Every number on the analytics page is recomputable from source rows;
  a bug fix changes the next render, not stored history.
- The client does a handful of bounded reads per view instead of a
  pre-aggregated fetch; if profiling ever shows this matters, a server
  read model can be added behind the same `AnalyticsInput` seam.
- No analytics data leaves the device: the only telemetry is a
  payload-free `analytics_viewed` event (spec AM).
