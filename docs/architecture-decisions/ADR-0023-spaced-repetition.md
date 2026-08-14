# ADR-0023: Explainable spaced repetition — a fixed ladder, not SM-2

- **Status:** Accepted
- **Date:** 2026-08-13
- **Milestone:** M8

## Context

Nursing students face fixed exam dates on a semester timeline. They need
review scheduling they can trust and understand ("why is this due
today?"), and the spec demands explainability over cleverness (spec K) and
a clean separation between what the evidence says and when review is due
(spec J). SM-2-family algorithms (Anki's ease factors, FSRS's fitted decay
curves) adapt per-item but produce intervals no student can predict or
verify, and their per-item state is easy to distort with a few unusual
answers.

## Decision

### 1. A fixed, visible interval ladder (spec K)

Review scheduling is a five-rung ladder of hours: **[24, 72, 168, 336,
720]** — one day, three days, one week, two weeks, one month. A concept
carries a `review_stage` (0–4); `next_review_at = answeredAt +
interval[stage]`. The ladder saturates at 720 h, matching a semester's
horizon — there is no "13-month interval" that outlives the course.

### 2. Movement rules a student could recite

- A **correct** answer advances the stage by one (capped at the top rung)
  — UNLESS the student marked the answer "guessing". A lucky guess is not
  evidence of retention, so the schedule does not stretch (spec H/K). An
  unstated confidence counts as ordinary evidence and advances.
- An **incorrect** answer resets the stage to 0: tomorrow, we look again.
- Nothing else moves the ladder. No hidden ease factor, no per-item decay
  parameter, no model fitting.

### 3. Urgency overlays evidence; it never erases it (spec J/Q)

The evidence band (unassessed / needs review / developing / strong,
thresholds centralized in config, spec Q) is computed from mastery alone.
When `now ≥ next_review_at`, the state shown becomes **due_for_review** —
an overlay, not a demotion: the underlying mastery number does not decay,
and answering the review well simply advances the ladder again. A concept
with no attempts is **unassessed** ("New"), never "needs review" — absence
of evidence is not evidence of weakness (spec C).

### 4. Scheduling arithmetic lives with the mastery write

The stage transition and `next_review_at` are computed inside the same
transactional RPC that applies the mastery update (migration 0008), from
the same event, mirrored constant-for-constant in `@avidia/mastery`
`config.ts`. There is no separate scheduler process to drift out of sync.

## Consequences

- Every due date is verifiable by hand: last answer time + a number from a
  five-element table. "Why today?" always has a one-sentence answer.
- The ladder is deliberately less adaptive than SM-2/FSRS; some students
  will see reviews slightly too early or late compared to a fitted model.
  We accept that cost for transparency and for robustness on the small
  per-concept sample sizes a single course produces.
- Because urgency and evidence are separate, the dashboard can say "Strong
  — due for review" honestly instead of pretending a strong concept became
  weak overnight.
- Changing the ladder is a config change under the algorithm version
  (ADR-0022), so historical events remain interpretable.
