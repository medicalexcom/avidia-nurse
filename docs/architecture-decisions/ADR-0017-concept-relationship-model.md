# ADR-0017: Concept relationship model and evidence cascade

- **Status:** Accepted
- **Date:** 2026-08-13
- **Milestone:** M6

## Context

Nursing reasoning is relational — a medication _treats_ a disease and _may
cause_ a lab abnormality. M6 needs relationships that are useful for future
study tooling without becoming a generic medical knowledge graph (spec I/J),
and every edge must be provable from the student's own material (spec K).

## Decision

### 1. Normalized edge table, controlled types (spec I)

`concept_relationships(course_id, source_concept_id, target_concept_id,
relationship_type, chunk_id)` — no JSON blobs, no free-text edges.
`relationship_type` is constrained to the domain list
(`CONCEPT_RELATIONSHIP_TYPES`): `treats`, `may_cause`, `indicates`,
`monitors`, `contraindicated_with`, `precedes`, `part_of`, `related_to`.
Directed edges; uniqueness on `(course_id, source, target, type)`.

### 2. Every edge carries chunk provenance (spec C/K)

`chunk_id` is NOT NULL and references `source_chunks` with `on delete
cascade`. A relationship the material no longer supports cannot exist: when
a document is reprocessed or deleted its chunks go, the evidence-bearing
edges go with them (the RPC additionally withdraws the document's previous
edges before applying new ones, spec O). No edge is ever inserted from
model output whose cited chunk does not belong to the document being
processed — the RPC re-verifies this server-side; the client-side refiner
is an optimization, not the security boundary.

### 3. Not a generic medical knowledge graph (spec J)

Relationships only connect concepts _within one course_, only when the
uploaded material states the connection, and only through the controlled
type list. There is no global edge namespace, no transitive inference, no
import of external ontologies. The product claim stays honest: "your course
materials say X may cause Y", never "medicine says".

### 4. Orphan pruning and emphasis (spec L/M)

`concept_sources` (concept ↔ chunk, normalized, no copied text) is the
evidence backbone. AI-origin concepts whose last supporting source
disappears are pruned by the RPC and by an `AFTER DELETE` trigger on
`documents`; future user-curated (`origin='user'`) concepts are exempt.
`emphasis_score` is a transparent count of supporting evidence
(recomputed by `recompute_concept_emphasis`), presented to students as
"found in N places in your materials" — a study-priority signal, explicitly
not an exam prediction.

## Consequences

- Stale knowledge is structurally impossible after reprocessing/deletion.
- Cross-document relationships (evidence in doc A connecting a concept that
  first appeared in doc B) are supported because endpoints resolve by
  normalized key/alias within the course while evidence stays chunk-bound.
- Rich inference (paths, clusters) is deferred; the normalized model makes
  it a query problem later, not a schema migration.
