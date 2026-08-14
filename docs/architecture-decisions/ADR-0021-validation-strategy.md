# ADR-0021: Validation strategy — untrusted generation, reject vs. flag

- **Status:** Accepted
- **Date:** 2026-08-13
- **Milestone:** M7

## Context

A generated question can be malformed (unscoreable), misleading (leaks its
answer, giveaway distractors), or dangerous (wrong insulin math taught with
confidence). Model output is treated as an untrusted content source
(spec J/L); nothing it says is persisted until it survives two independent
gates, and safety concerns must not silently disappear OR silently ship.

## Decision

### 1. Two gates: structural, then clinical

- **Gate 1 — schema (`schema.ts`, spec J):** field-by-field structural
  validation of the raw model JSON (types, enums, lengths, chunk-index
  bounds). The gateway allows exactly one repair round replaying the
  violations; a second failure fails the batch. Malformed output can never
  be persisted because it never becomes a typed object.
- **Gate 2 — clinical (`validate.ts`, spec K/L/N):** every structurally
  sound question is judged BEFORE persistence and lands in exactly one of
  three buckets: **accepted (active)**, **accepted (flagged)** with named
  `safety_flags`, or **rejected** with named reasons (logged, never
  persisted as usable).

### 2. Hard rules → REJECT (spec K)

Violations that make an item unscoreable or misleading are fatal:
option-count ranges per type (SBA 3–6, SATA 4–6, ordered 3–6), exactly one
correct for SBA, ≥2 correct but not all for SATA (multi-correct is a design
intent, not an accident), `correct_position` covering 1..n exactly for
ordered, numeric requiring finite expected value and tolerance ≥ 0 with NO
options, cross-type field contamination, duplicate options, and answer
leakage (the correct option's text appearing in the stem). In-batch and
in-course duplicates (by content hash) are dropped as duplicates, not
errors.

### 3. Soft rules → FLAG, excluded from study until review (spec L/N/S)

Quality/safety smells persist the question as `flagged` (invisible to
students via RLS) rather than discarding possibly good work:
`missing_distractor_rationale`, `absolute_term_option` ("always"/"never"/
"all of the above"), `longest_option_correct` (the classic test-taking
giveaway). Questions touching high-risk terms (insulin, heparin, warfarin
and other anticoagulants, dosing, emergency scenarios — `HIGH_RISK_TERMS`)
get **stricter** treatment: numeric items must carry a unit and a tight
tolerance, and rationales must not be thin (`high_risk_missing_unit`,
`high_risk_wide_tolerance`, `high_risk_thin_rationale`).

### 4. Honest sourcing is computed, not claimed (spec H)

`source_type` is derived: cited chunk indexes ⇒ `course_grounded`; none ⇒
`general_knowledge`. The model's own claim is ignored. The persistence RPC
re-verifies chunk ids against the document, so even a hallucinated citation
cannot fabricate attribution.

### 5. Student flags are input, never authority (spec AH)

`question_feedback` (answer_wrong / question_unclear / rationale_unclear /
source_mismatch / other + optional comment) is stored for review. Nothing
reads it automatically; a report never changes an answer key or status. A
student who is wrong about being right cannot corrupt the item bank; a
student who is right creates a reviewable trail.

### 6. Quality evaluation on synthetic fixtures (spec AI/AJ)

`evalFixtures.ts` provides synthetic nursing scenarios (hyperkalemia, DKA,
PE, COPD, HF, furosemide) — written for this repo, no NCLEX or commercial
bank content. The test suite runs the full generate→validate→persist path
on them deterministically (scripted provider), including doctored batches
proving that two-correct SBAs, leaky stems and giveaway distractors are
caught.

## Consequences

- The pipeline prefers fewer, defensible questions over volume; sparse or
  poor materials produce visibly small (or empty) sets.
- Flagged items accumulate until a review tool exists (future milestone);
  they are stored with their named flags so triage is cheap.
- Validation rules live in one place with named reasons, so every rejection
  in worker logs is explainable and testable.
