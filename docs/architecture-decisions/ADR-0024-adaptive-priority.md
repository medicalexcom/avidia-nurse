# ADR-0024: Adaptive priority and recommendation model

- **Status:** Accepted
- **Date:** 2026-08-13
- **Milestone:** M8

## Context

"What should I study next?" is the product's central question. The answer
must come from a deterministic, versioned function of the student's own
data (spec N/O/S), be explainable without an LLM (spec T), respect exam
proximity from the M2 exam dates with correct timezones (spec L/AI), and
select real questions from the persisted M7 bank — working fully with zero
AI configuration (spec U/V). A black-box ranker would violate the
milestone's core principle even if it ranked well.

## Decision

### 1. A multiplicative factor model (spec N/O/L/R)

Each concept's priority is a product of named, bounded factors:

- **Exam relevance:** stepped urgency from calendar-day distance to the
  next exam (config `EXAM_URGENCY_STEPS`), computed with the SAME
  timezone-correct domain utility the countdown UI uses (spec AI), so
  scheduling and display can never disagree. Exam scope is course-wide in
  v1 with a `conceptIds` manual-adjustment path (spec M).
- **Weakness:** distance from mastery to 1 (unassessed counts as fully
  unknown — maximum weakness, honestly).
- **Forgetting risk:** grows toward the review due time; floored at 0.15
  right after practice, 0.6 for never-assessed concepts.
- **Course emphasis:** M4 `emphasis_score` normalized against the
  strongest concept in the course and bounded (spec N) — emphasis nudges,
  it never dominates.
- **Misconception:** confident-error severity (ADR-0022 §3) raises
  priority so miscalibration gets addressed soonest.
- **Transfer need:** a concept with only recall-level evidence and no
  higher-order correct answer gets a push toward application/analysis
  practice.

Multiplication (not addition) means a concept must matter on several axes
to reach the top, and any single zeroed factor (e.g., no exam pressure)
softens rather than deletes the ranking. Ties break deterministically by
concept id. The function is versioned alongside the mastery algorithm.

### 2. Reason codes ARE the explanation (spec S/T)

`rankConcepts` emits machine reason codes per concept — `unassessed`,
`low_mastery`, `review_due`, `exam_soon`, `recent_error`,
`high_course_emphasis`, `question_supply_low` — derived from the same
factor inputs. The UI maps them to fixed, non-judgmental domain labels
("Recent answers suggest a gap here", "Relevant to an upcoming exam").
No LLM ever writes the explanation; the explanation cannot hallucinate
because it is the computation.

### 3. Deterministic, seeded question selection (spec U/V/W/X/Y)

`buildAdaptiveQuestionOrder` orders questions from the persisted bank:
unseen questions first, then best match to mastery-appropriate target
characteristics (harder/higher-order as mastery grows, spec U), under
diversity bounds (max 2 consecutive per concept, ≤50 % session share,
spec W). The study session id seeds the ordering, so a mid-session
refresh resumes the identical sequence (spec AB) and no randomness source
leaks in. When supply runs thin, constraints relax gracefully and the
concept is tagged `question_supply_low` — a reason code and a supply
signal, NEVER a trigger for an AI generation call (spec Y).

### 4. The UI renders; it never calculates (spec AH/AF)

`studyApi.ts` assembles owner-scoped rows into pure snapshots; screens
hand those to the engine and render its output — ONE recommended action
with its reasons, coarse state groups with counts only, no percentages or
predictions (spec AF/AG). The dashboard cannot disagree with the engine
because it holds no logic of its own.

## Consequences

- Recommendations are reproducible: same rows in, same ranking out, on
  any device, with or without network access to an AI provider.
- Every recommendation carries its own audit trail (per-factor breakdown
  in `factors`), which M9 analytics can consume without re-deriving
  anything.
- A stepped, hand-tuned factor model will sometimes rank differently than
  a learned one; we accept that for explainability, and the version field
  gives future tuning a safe path.
- Cold start is honest by construction: unassessed concepts rank high with
  the reason "You haven't practiced this yet" instead of a fabricated
  score.
