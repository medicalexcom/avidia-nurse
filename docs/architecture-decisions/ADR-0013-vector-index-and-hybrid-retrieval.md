# ADR-0013: pgvector index and hybrid retrieval

- **Status:** Accepted
- **Date:** 2026-08-13
- **Milestone:** M5

## Context

Retrieval must be course-scoped, authorization-enforced in the database, and
good at nursing queries — which mix conceptual questions ("signs of left
sided heart failure") with exact clinical tokens (FEV1, PaCO2, DKA,
furosemide, Kussmaul, INR) that pure vector similarity often fuzzes over.

## Decision

### 1. pgvector in the `extensions` schema; HNSW, cosine

`vector(1536)` on `source_chunks.embedding`, indexed with
`hnsw (embedding vector_cosine_ops)` at default parameters (m=16,
ef_construction=64). HNSW over IVFFlat because it needs no training step on
an empty table and holds good recall as data grows; defaults are right at
MVP scale — tuning now would be premature optimization. Cosine matches the
normalized-embedding convention of every candidate provider.

### 2. Hybrid retrieval: vector + lexical, fused with RRF (spec L)

`search_course_chunks` runs two legs over the caller's course:

- **Vector leg** — cosine similarity ordering via the HNSW index.
- **Lexical leg** — Postgres full-text search over a stored generated
  `content_tsv` column (GIN-indexed), using `websearch_to_tsquery('english')`.

Both legs take a candidate pool of `4 × top_k` (min 20) and are merged with
reciprocal-rank fusion: `score = Σ 1/(60 + rank)`. RRF needs no score
normalization between cosine and ts_rank, is robust to either leg being
weak, and is the standard simple fusion. The lexical leg is what guarantees
that a query for "FEV1" surfaces the chunk that literally says FEV1.
`min_similarity` filters the vector leg only; a lexical hit always survives
(an exact term match is relevant even when hashed/semantic cosine is low).

### 3. Authorization inside the database function (spec K/T)

`search_course_chunks` is SECURITY DEFINER: it verifies
`courses.user_id = auth.uid()` for the requested course and raises if the
caller does not own it; anonymous callers have no EXECUTE grant. Screens
and services never query pgvector directly — they go through
`CourseKnowledgeRetriever` → RPC — so a forgotten filter in product code
cannot leak another user's chunks. Post-filtering in the UI is not a
security layer here; the database is.

### 4. Vectors never leave the database (spec U)

The RPC returns chunk text, provenance, and scores — never embeddings. The
`embedding` (and `content_tsv`) columns are excluded from the client
column-level SELECT grant, so even a hand-written client query cannot read
a vector.

## Consequences

- `top_k` is clamped to 1–50 server-side; defaults: top_k 8, threshold 0.
- The service role (worker CLI) may call the RPC without a user context for
  internal inspection; ownership is enforced for every authenticated caller.
- If recall degrades at scale, tune `hnsw.ef_search` / index parameters
  before considering re-ranking models — measure first via the eval set.
