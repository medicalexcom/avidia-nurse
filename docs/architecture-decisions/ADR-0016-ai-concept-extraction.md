# ADR-0016: AI concept extraction — gateway, validation, versioning, cost

- **Status:** Accepted
- **Date:** 2026-08-13
- **Milestone:** M6

## Context

M6 is the first milestone where an LLM output becomes persisted product
data. That demands stronger controls than a chat feature: strict structure,
auditability, retry safety, cost bounds, and a hard line between what the
course material says and what the model merely knows (spec D/E/K/S).

## Decision

### 1. Provider-independent gateway (spec D)

`ConceptExtractionProvider` in `@avidia/knowledge` is a small interface
(`extract(chunks) → RawExtraction + metadata`). Two implementations ship:

- **`OpenAiConceptExtractionProvider`** — `gpt-4o-mini` via plain `fetch`
  (no SDK dependency), `temperature: 0`, and `response_format:
json_schema` with `strict: true` so the model is _constrained_ to the
  schema, not merely asked. Chosen for cost: extraction is high-volume,
  structured, and closed-ended — a frontier model is not required, and the
  provider swap is one env var away if quality demands it.
- **`ScriptedConceptExtractionProvider`** — deterministic word-boundary
  lexicon matcher for tests, evals and offline dev. No network, ever.

Selection via `CONCEPT_PROVIDER` / `CONCEPT_MODEL` / `OPENAI_API_KEY`;
worker-only, never in the client bundle.

### 2. Strict validation with one controlled repair round (spec E)

Every response is validated by `validateExtraction` (hand-written, no
schema library): required fields, chunk-index bounds, size limits (≤60
concepts/batch, ≤1000-char summaries, ≤6 aliases), relationship shape.
On violation, exactly one repair round replays the model's own JSON with
the violation list and demands corrected output; a second failure fails the
document (spec T) — no silent acceptance, no unbounded repair loops.
Transport errors get 3 attempts with backoff on 429/5xx only; other 4xx
fail fast.

### 3. Versioning and audit (spec E)

`CONCEPT_EXTRACTION_VERSION` ('v1') and `CONCEPT_PROMPT_VERSION` ('p1') are
code constants; provider and model are recorded per extraction. Every
concept row carries `ai_provider`, `ai_model`, `prompt_version`,
`extraction_version` — any concept can be traced to exactly what produced
it, and version bumps change the fingerprint (below) to force re-runs.

### 4. Fingerprint cost gate + batching (spec S)

Before calling AI, the worker computes a SHA-256 over
provider/model/prompt-version/extraction-version plus every chunk id and
content. If it equals the stored `knowledge_fingerprint`, the document is
marked ready with **zero** AI calls — retries, sweeps and no-op
reprocessing are free. Chunks batch at ~6000 estimated tokens / 12 chunks
per request; batch-local chunk indexes are re-based so provenance survives
batching.

### 5. Privacy and grounding (spec K)

Chunk text goes to the provider only for extraction; no student identity
accompanies it. The prompt demands concepts _taught by this material_ with
cited chunk indexes; uncited concepts are schema violations. Nothing the
model knows independently can enter the course knowledge model without a
chunk citation — the "course-sourced vs general AI knowledge" line is
enforced structurally, not by tone.

## Consequences

- Extraction is auditable, replayable and cheap to retry; a failed
  extraction leaves the document fully retrievable (knowledge lifecycle is
  independent of M4/M5 states).
- gpt-4o-mini may under-extract subtle concepts; the eval fixtures (spec U)
  exist to measure exactly that, and the gateway makes upgrading trivial.
