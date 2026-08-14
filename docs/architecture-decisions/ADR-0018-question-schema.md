# ADR-0018: Question schema — types, lifecycle, provenance, no answer leakage

- **Status:** Accepted
- **Date:** 2026-08-13
- **Milestone:** M7

## Context

M7 turns the M6 knowledge model into practice questions. Question data is
unusual: half of every row (the correct answer, the rationale, the expected
numeric value) must be persistently stored yet **never readable** by the very
user who owns it — until after they answer. The schema, not application code,
has to carry that guarantee (spec K/AB).

## Decision

### 1. Reliably scorable types only (spec C)

`question_type ∈ {single_best_answer, multiple_response, ordered_response,
numeric_calculation}`. Every type has a deterministic, argument-free scoring
rule (set equality, sequence equality, tolerance band). Formats that need
judgment to grade (short answer, essay, hot-spot) are excluded on purpose:
a wrong automated grade teaches a nursing student the wrong clinical
behavior, which is worse than no question.

### 2. Normalized options with deterministic ordinals (spec B)

`question_options` is a real table (not JSON): `ordinal` is assigned at
generation time and unique per question, so an item renders identically on
every device and revisit — no client-side shuffling that would make
rationales and review confusing. `is_correct`, `correct_position` and the
per-distractor `rationale` live on the same row but are **not in the
column-level SELECT grant**.

### 3. Answer leakage is impossible by grant, not by discipline (spec K)

`questions.rationale/expected_value/tolerance/answer_unit/rounding_note` and
`question_options.is_correct/correct_position/rationale` are excluded from
the `authenticated` column grants. A compromised or curious client asking
for them gets a database error, not data. The only reveal path is the
`submit_question_attempt` return value, after the attempt row exists
(ADR-0020).

### 4. Lifecycle with a single student-visible state (spec S/L)

`status ∈ {generated, active, flagged, rejected, retired}`; the RLS select
policy hard-codes `status = 'active'`. Validation runs BEFORE persistence
(ADR-0021), so the pipeline writes only `active` (clean) or `flagged`
(carrying `safety_flags` for review). `retired` is for questions whose
evidence disappeared. Students can never see a flagged or retired item, and
no client write can change a status.

### 5. Provenance and honest sourcing (spec G/H/Q)

`question_sources` links each question to the exact `source_chunks` rows it
was generated from; the RPC joins the claimed chunk ids against the document
being processed, so a question can never cite evidence from a different
document or course. `source_type` is **derived from citations**
(`course_grounded` requires chunk provenance) — a question is never labeled
as "from your materials" unless it can prove it. Deleting a document
cascades the links and a trigger retires course-grounded questions left
with zero evidence: stale attribution cannot exist.

### 6. Numeric math as data (spec P)

`numeric_calculation` rows must carry `expected_value` + `tolerance`
(CHECK-enforced), with optional `answer_unit`/`rounding_note`; all four are
CHECK-forbidden on other types. Scoring is a numeric comparison in SQL. No
language model ever performs arithmetic at answer time.

### 7. Dedup by content hash (spec R)

`content_hash` (SHA-256 of normalized type + stem + options) is unique per
course. Re-generation of the same material reuses the existing row and
refreshes provenance instead of inserting near-copies; legitimately
different questions about the same concept hash differently and coexist.

## Consequences

- Clients render questions from public columns only; every answer reveal is
  an auditable RPC round-trip (the cost of the leakage guarantee).
- Adding a new question type requires a scoring rule in BOTH the SQL scorer
  and the TypeScript mirror before it can exist (deliberate friction).
- The `generated` status is currently unused by the pipeline (validation
  precedes persistence) but reserved for future ingestion paths.
