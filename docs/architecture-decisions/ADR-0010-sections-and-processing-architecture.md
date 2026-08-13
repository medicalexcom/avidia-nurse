# ADR-0010: document_sections model, worker architecture, and the M5 boundary

- **Status:** Accepted
- **Date:** 2026-08-12
- **Milestone:** M4

## Context

M4 must store extraction results in a normalized, provenance-preserving
model; process documents in the background through the
UPLOADED → QUEUED → PROCESSING → READY | FAILED lifecycle; make reprocessing
idempotent; and hand M5 a clean structural layer — while creating **no**
embeddings or retrieval structures. The Playbook's schema sketch includes
`source_chunks` with an `embedding vector` column and its M4 milestone line
says "extraction, chunks, provenance, retry", which had to be reconciled
with the M4 spec's explicit no-embeddings rule.

## Decision

### 1. `document_sections`, not `source_chunks`, is M4's output

M4 writes **structural** units: `document_sections(id, document_id,
section_type, sequence, page_number, slide_number, heading, content,
metadata, created_at)` with a gapless per-document sequence and an
ON DELETE CASCADE foreign key. This is the faithful record of what the
document says, in order, with source locations — a queryable relational
model, never an opaque JSON blob.

`source_chunks` (with its pgvector `embedding` column) is M5's **semantic**
layer: chunking for retrieval is an embedding-model-dependent decision
(token budgets, overlap, merging small sections) that belongs with the
embedding work. M5 derives chunks _from_ `document_sections`; deriving them
now would freeze retrieval decisions before retrieval exists. This resolves
the Playbook wording: M4 delivers the extraction/provenance/retry substance,
and the chunk table arrives with the embeddings that give it meaning.

### 2. State machine enforced in the database, not by client honor

A BEFORE UPDATE trigger (`enforce_document_status_transition`) rejects any
transition outside `uploading→uploaded|failed`, `uploaded→queued`,
`queued→processing`, `processing→ready|failed`, `failed→uploading|queued`,
and additionally rejects entry into `processing` or `ready` whenever
`auth.uid()` is non-null. Consequences: clients may enqueue and retry, but
only the service-role worker can claim work or declare success — a
compromised client cannot fake a READY document or forge extraction state.
Student-visible `error_message` and internal-only `processing_detail` are
separate columns, and `processing_detail` is excluded from the authenticated
column grant.

### 3. Postgres-as-queue behind a `WorkerClient` seam

The worker polls for `queued` rows and claims them with an optimistic
compare-and-set (`UPDATE … SET processing_status='processing',
processing_attempts=attempts+1 WHERE id=? AND processing_status='queued'`),
which is race-safe across concurrent workers without advisory locks. A
durable message queue is intentionally deferred: at current scale a poll
loop is operationally simpler, has no new infrastructure, and the entire
I/O surface is the six-method `WorkerClient` interface
(claim/download/replaceSections/markReady/markFailed/recoverStale), so a
later move to pgmq/SQS/etc. replaces one adapter file. Extraction never
lives inside a React component or request handler. A sweep converts
documents stuck in `processing` (> 15 min) to `failed` so a crashed worker
never strands a student's upload.

### 4. Idempotency via one atomic replace RPC

All section writes go through `replace_document_sections(document_id,
sections)` — SECURITY DEFINER, `search_path = public`, delete + insert in a
single transaction, EXECUTE revoked from anon/authenticated. Properties:

- Reprocessing **converges** (same input → same rows); duplicate sections
  are impossible by construction, satisfying retry-safety without
  bookkeeping tables.
- Partial writes are impossible — a failure mid-insert rolls back to the
  previous section set, and the document is marked FAILED, never READY with
  half its content.
- Clients cannot write sections at all: `document_sections` has forced RLS
  with a SELECT-only ownership policy (through the course join) and no
  INSERT/UPDATE/DELETE grants.

### 5. Quality gate before any write

`validateSectionBatch` (domain) enforces the section contract — gapless
0-based sequence, known types, non-empty content within bounds — and the
dispatcher fails the document (`no_text`/`malformed`) rather than persisting
a violating batch. READY therefore _means_ "at least one valid, ordered,
provenance-bearing section exists".

## Consequences

- M5 consumes a stable structural layer and owns all semantic decisions
  (ontology, embeddings, pgvector, retrieval) cleanly.
- Poll latency (≤ 5 s) is acceptable now; the seam documents the upgrade
  path when it is not.
- The worker is a separate deployable (`apps/worker`) needing only
  `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; hosting it is a manual
  operations step until a deployment target is chosen.
