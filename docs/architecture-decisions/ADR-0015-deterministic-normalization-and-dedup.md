# ADR-0015: Deterministic normalization, dedup and aliases

- **Status:** Accepted
- **Date:** 2026-08-13
- **Milestone:** M6

## Context

The extractor sees the same concept written many ways — "DKA", "Diabetic
Ketoacidosis", "diabetic ketoacidosis (DKA)" — across documents processed at
different times. Duplicates would corrupt emphasis scores and clutter the
student view. But the opposite failure is worse: merging clinically
_distinct_ concepts (hyperkalemia vs hypokalemia, hypoglycemia vs
hyperglycemia) would teach students wrong medicine.

## Decision

### 1. Deterministic-first: normalize before any AI judgment (spec F)

`normalizeConceptKey` in `@avidia/knowledge` is the single source of truth
for identity: Unicode NFKC → lowercase → strip everything but letters/digits
(Latin range) to spaces → collapse whitespace. The key is pure formatting
normalization — it never alters letters. "Hyperkalemia" and "hypokalemia"
differ by a letter, so they can never collide; the near-twin hazard is
structurally impossible, not just tested for. AI similarity is _not_ used
for merging in M6; anything the deterministic key doesn't merge stays
separate. Safe over clever.

### 2. Generic-term rejection

A stoplist (`patient`, `care`, `nursing`, `chapter`, `overview`, …) rejects
candidates only when _every_ word is generic: "Assessment" is dropped,
"Heart Failure" and "Pain Assessment" survive. Dropped names are surfaced in
refinement telemetry, never silently discarded.

### 3. Aliases as first-class rows (spec G)

`concept_aliases` maps alternate names (abbreviations, brand names) to one
concept per course, unique on `(course_id, normalized_alias)`. During
refinement and inside `apply_concept_extraction`, resolution order is:
exact normalized key → existing alias claiming that key → candidate alias
matching an existing concept. When an abbreviation meets its expansion, the
fullest name is promoted to canonical ("DKA" → "Diabetic Ketoacidosis") and
the shorter form is kept as an alias — deterministically (length
comparison), never by AI preference.

### 4. Merge logic lives in both layers, same rules

The worker's `refineExtraction` dedups within a single extraction run; the
`apply_concept_extraction` RPC applies identical resolution against what is
already in the database, in one transaction. Retries and multi-document
courses therefore converge to the same state (idempotent, spec N).

## Consequences

- Zero risk of letter-level false merges; some true duplicates may persist
  if written with genuinely different words ("MI" never merges with
  "Myocardial Infarction" unless the alias link is extracted). Accepted:
  a visible duplicate is fixable; a silent wrong merge is dangerous.
- Determinism makes the quality eval (spec U) exactly repeatable.
