# ADR-0034: Study planner as a deterministic scheduling layer over M8/M12

- **Status:** Accepted
- **Date:** 2026-08-14
- **Milestone:** M13

## Context

M13 adds an intelligent study planner: exam-aware daily schedules, a Today
view, a week view, and reminders. The instruction's core principle is
absolute: M13 IS NOT ANOTHER MASTERY ENGINE. M8 owns mastery, review
urgency, study priority, and spaced repetition; M12 owns analytics and
readiness. The planner must only answer "WHEN should the student study
WHAT?" — deterministically, testably, and with zero AI dependency
(spec N/AQ). It must schedule across multiple courses without mixing
course-scoped data (spec G), respect a realistic time budget (spec D/P),
and adapt when reality diverges from the plan (spec R/S/T).

## Decision

### 1. One pure package: `@avidia/planner`

`createStudyPlan(input) → StudyPlanResult` is a deterministic, pure
function. Inputs are already-computed outputs of existing engines: M8
`rankConcepts` snapshots and due-review IDs per course, M12
cognitive-level slices (for the higher-order-gap flag), M10 mode
eligibility, M11 case counts, M2 exams, and the student's availability.
Same inputs, same plan — every golden case (A–H) asserts on exact
structure. No LLM is ever consulted; there is nothing for an AI outage to
break.

### 2. Demand → triage → placement

Generation has three phases. **Demand:** each course contributes typed
activity needs (due reviews, misconception remediation, exam-priority
practice, coverage blocks for unassessed concepts, higher-order and
clinical practice, keep-fresh enrichment) with minute estimates and
deterministic reason codes. **Triage:** needs are ordered by the fixed
tier order — misconceptions, exam priorities, due reviews, unassessed
coverage, higher-order practice, enrichment — with exam urgency scaling
allocation between courses so a near exam cannot starve another exam's
substantial unmet coverage (spec F). **Placement:** needs fill per-weekday
budgets front-to-back across the horizon; nothing is placed beyond the
day's minutes. If total need exceeds total capacity the plan carries an
explicit `overCapacity` flag and the UI states the constraint honestly
(spec P) — work is prioritized, never silently compressed.

### 3. Recalculation IS regeneration

There is no incremental patching. Any trigger — completed work, missed
day, changed exam, changed availability — regenerates the plan from
current evidence and saves a new revision. Because inputs already reflect
completed sessions and updated mastery, missed days are re-triaged rather
than stacked onto tomorrow (spec S), and extra study is absorbed
automatically (spec T). This keeps the engine pure and the audit trail in
the persistence layer.

### 4. Persistence: revisioned plans, RPC-only writes

`planner_settings` (one row per user), `study_plans` (revisioned; a
partial unique index enforces exactly one ACTIVE plan per user), and
`planned_activities` (typed, positioned, reasoned rows) live behind
SECURITY DEFINER RPCs. `save_study_plan` validates course ownership,
supersedes only PENDING rows of the old revision — completed and skipped
rows keep their status forever (spec AM/Z) — and inserts the next
revision. Completion is evidence-based: `complete_planned_activity`
requires a caller-owned, same-course, COMPLETED study or simulation
session, and per-column unique indexes make one session unable to satisfy
two activities (spec U/AN). Screen-opens never complete anything.

### 5. UI renders, never schedules

Screens fetch stored rows and forward taps to existing experiences: the
M9 adaptive session, M10 modes, or the M11 simulation route (spec M/Y).
`matchSessionsToActivities` (pure) reconciles actual completed sessions to
pending activities on load. The planner is reached from the Today card and
deep links; it adds no new study engine and no new statistics.

## Consequences

- The planner can never disagree with M8/M12 — it consumes their outputs
  verbatim and holds no derived learning state.
- Determinism makes golden cases A–H exact and cheap (~1s suite).
- Regeneration-as-recalculation trades minimal write volume for
  simplicity; revisions bound history and keep auditability.
- Cross-course plans exist only at the schedule level; every activity row
  stays course-scoped, preserving RLS and data separation.
- Future M14+ features (e.g., analytics on plan adherence) read the same
  structured rows without schema changes.
