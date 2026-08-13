# ADR-0014: Concept taxonomy and course-scoped knowledge model

- **Status:** Accepted
- **Date:** 2026-08-13
- **Milestone:** M6

## Context

M6 introduces the nursing concept and knowledge model: the structured layer
between raw course material (M4/M5) and future study tooling. Two questions
had to be settled before any table existed: what _kinds_ of things count as
concepts (taxonomy), and what namespace a concept lives in (scoping).

The Playbook §7 sketches a globally shared ontology seeded across users.
That design has a serious privacy and correctness hazard for this product:
concepts are extracted by AI from private uploaded course material, so a
shared namespace could leak one student's course content (concept names,
summaries, relationships) into another student's experience, and a merge in
one course could silently rewrite another course's knowledge.

## Decision

### 1. Concepts are course-scoped, never global (spec A)

Every row in `concepts`, `concept_aliases`, `concept_sources` and
`concept_relationships` carries `course_id` and cascades with the course.
Normalized-key uniqueness is `(course_id, normalized_key)` — two courses can
each have their own "Heart Failure" with different summaries, evidence and
emphasis, because they genuinely come from different materials. Nothing a
student uploads can influence any other user's (or any other course's)
knowledge model. This is a deliberate deviation from Playbook §7's shared
ontology; a curated global seed can be layered on later as a _separate_,
read-only vocabulary without changing this model.

### 2. Controlled, extensible type taxonomy (spec B)

`concept_type` is a text column constrained to a controlled list defined
once in `@avidia/domain` (`CONCEPT_TYPES`): `disease_process`, `medication`,
`laboratory`, `assessment_finding`, `procedure`, `nursing_intervention`,
`anatomy_physiology`, `patient_education`, `safety_protocol`, `other`.
The list is nursing-shaped (what a nursing course actually teaches) rather
than a biomedical ontology import. `other` is the honest escape hatch: the
extractor never invents a type, and unknown model output is coerced to
`other` during refinement rather than rejected. Adding a type is a
domain-package edit plus a migration — controlled, but extensible.

### 3. Reasoning dimensions are extensible attributes, not columns (spec H)

Clinical-reasoning facets (e.g. priority level, safety relevance) are not
hardcoded as dedicated columns. The relationship model (ADR-0017) plus the
typed taxonomy carry today's needs; future dimensions attach as new
relationship types or a keyed attribute table without schema rewrites.

### 4. Status over deletion

`concepts.status` (`active` | `archived`) lets future curation retire a
concept without destroying provenance. The UI only shows `active`.

## Consequences

- No cross-course or cross-user knowledge leakage is possible at the schema
  level; RLS enforces owner-only reads and the authz harness proves it.
- Some duplication across courses (each course re-extracts "Hypokalemia").
  Accepted: correctness and privacy outrank storage, and the fingerprint
  cost gate (ADR-0016) keeps AI spend bounded.
- The Playbook §7 deviation is recorded here deliberately.
