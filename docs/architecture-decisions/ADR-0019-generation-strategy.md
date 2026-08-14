# ADR-0019: Question generation strategy — gateway, grounding, cost control

- **Status:** Accepted
- **Date:** 2026-08-13
- **Milestone:** M7

## Context

Question generation is the second milestone (after M6 extraction) where LLM
output becomes persisted product data. It must be grounded in the student's
own materials, provider-independent, aggressively cost-controlled, and —
critically — **never in the study path**: a student sitting down to practice
must not depend on a live model being up (spec AE/AF).

## Decision

### 1. Background pipeline, never on-demand-in-session (spec AE/Y)

Generation runs in the worker as a fourth document lifecycle
(`documents.question_status`: pending → generating → ready | failed),
triggered when a document's knowledge extraction is ready. Study sessions
read only previously persisted questions; the app has no code path that
calls a generation provider. A failed generation leaves reading, retrieval
and concepts untouched (failure isolation, same doctrine as M5/M6).

### 2. Provider-independent gateway (spec I)

`QuestionGenerationProvider` in `@avidia/assessment` mirrors ADR-0016's
seam: `generate(concepts, chunks) → RawGeneration` plus metadata. Production
is `gpt-4o-mini` via plain `fetch` (Playbook §16 routes high-volume,
schema-validated generation to the low-cost model), `temperature` fixed,
`response_format: json_schema` with `strict: true`, one controlled repair
round on schema violation, bounded retries with backoff on transport
failures. `ScriptedQuestionGenerationProvider` is the deterministic keyless
mode for tests/dev — never production. Selection via `QUESTION_PROVIDER` /
`QUESTION_MODEL` / `OPENAI_API_KEY`, worker-only.

### 3. Grounding and minimal payloads (spec G/AC)

The prompt receives only what generation needs: the top course concepts by
transparent M6 emphasis (`pickGenerationConcepts`, capped at 8 per document)
and the document's chunks with human locators. No profile data, no other
documents, no conversation state. The model must cite 0-based chunk indexes
per question; the RPC later resolves and verifies them against the actual
document (ADR-0018 §5). M6 emphasis influences only which concepts are
offered — it is metadata, never a difficulty or importance promise
(spec AA/Z).

### 4. Fingerprint cost gate + versioning (spec AD/Y)

`computeQuestionFingerprint` hashes the selected concept keys, chunk ids and
contents, and the prompt/generation versions. The worker skips the AI call
entirely (and logs "questions unchanged (fingerprint match, no AI call)")
when the stored `question_fingerprint` matches. `QUESTION_PROMPT_VERSION`
('p1') and `QUESTION_GENERATION_VERSION` ('v1') are stamped on every
question and provenance link, so a prompt change is visible in the data and
deliberately invalidates fingerprints.

### 5. Concurrency-safe claiming (mirrors M4–M6)

Documents are claimed with a compare-and-swap on
`question_status = 'pending' ∧ knowledge_status = 'ready'`; a 15-minute
stale sweep returns crashed claims to pending. `apply_question_generation`
is transactional and idempotent — a retry after a crash re-applies without
duplicates because dedup is content-hash-based.

## Consequences

- Cold cost per document is one model call bounded by 8 concepts; unchanged
  re-runs are free. Every question row carries provider/model/versions for
  audit and future migration.
- Provider swap (or a future on-demand path) is contained behind the
  gateway interface plus one env var.
- Generated quality depends on chunk quality; thin materials yield few or
  zero accepted questions, which the pipeline reports honestly rather than
  padding with generic items.
