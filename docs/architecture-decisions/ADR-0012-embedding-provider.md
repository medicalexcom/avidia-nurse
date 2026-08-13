# ADR-0012: embedding provider and model

- **Status:** Accepted
- **Date:** 2026-08-13
- **Milestone:** M5

## Context

M5 needs a production-capable embedding model for clinical/education text,
behind a provider-agnostic abstraction (Playbook §16: no provider SDK types
in domain logic), with version metadata that supports re-embedding when the
model or chunking changes. Embeddings are the only AI capability in M5 —
no reasoning/generation LLM is used (answering is M10).

## Decision

### 1. Production model: OpenAI `text-embedding-3-small` (1536 dims)

Strong retrieval quality on clinical text, native batching (we batch 100
inputs per call), low cost (≈$0.02 per million tokens — a 50-slide deck is a
fraction of a cent), and a stable, simple API. Called with plain `fetch` —
no vendor SDK, so nothing leaks past the provider module. Bounded retry
(3 attempts, linear backoff) on 429/5xx/network errors; non-retryable 4xx
fails fast. Responses are validated for count and dimension.

### 2. `EmbeddingProvider` interface

`embedDocuments(texts)`, `embedQuery(text)`, `metadata()` — the seam where a
different provider (Voyage, Cohere, local) can be swapped in. Every stored
chunk records `embedding_provider`, `embedding_model`, `embedding_version`
(`v1`), and the dimension is fixed at 1536 in the schema.

### 3. Re-embedding path

Bump `EMBEDDING_VERSION` whenever the provider, model, or chunking algorithm
changes incompatibly; reset `documents.index_status` to `'pending'` and the
worker rebuilds chunks and vectors. A provider with a different dimension
additionally requires a column migration — acceptable, deliberate friction.

### 4. `HashingEmbeddingProvider` for tests and keyless development

A deterministic FNV-1a hashed bag-of-words vector (L2-normalized, same
1536-dim space) used by tests, the retrieval-quality eval, and local dev
without an API key (`EMBEDDING_PROVIDER=hashing`). It is NOT a semantic
model and must never be configured in production; it exists so the entire
pipeline — chunking, storage, hybrid retrieval, grounding — runs and is
measurable offline.

### 5. Selection via server-side env contract (Playbook §5)

`EMBEDDING_PROVIDER` (default `openai`) + `OPENAI_API_KEY`, read only by the
worker. Client bundles never hold provider keys; the internal retrieval
inspector is therefore a worker CLI, not an app screen.

## Data flow and privacy (spec U)

Chunk **text** (extracted from user-uploaded course material) is sent to
OpenAI's embeddings endpoint over TLS to produce vectors. No student
identity, course names, filenames, or metadata are sent — only chunk/query
text. Per OpenAI's API policy, API data is not used for training. Vectors
are stored in Postgres under forced RLS; the raw `embedding` column is not
in the client column grant, so vectors never reach clients (the retrieval
RPC returns text, provenance, and scores only). This flow is documented for
the founder's privacy policy; if a zero-third-party posture is ever
required, the provider seam allows a self-hosted embedding model.

## Consequences

- One provider today, swappable later without touching domain code.
- Approximate cost tracking: the worker logs chunk counts and the summed
  token estimate per indexed document.
- Rejected alternatives: Cohere/Voyage (comparable quality, but the founder
  already holds an OpenAI-compatible path and one vendor is simpler for
  MVP); local models (operational burden too high for a solo founder);
  `text-embedding-3-large` (2× cost for marginal gain at MVP scale).
