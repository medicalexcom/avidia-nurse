# ADR-0011: structural semantic chunking

- **Status:** Accepted
- **Date:** 2026-08-13
- **Milestone:** M5

## Context

M5 must turn M4's normalized `document_sections` into retrieval-ready chunks.
The failure mode to avoid is blind fixed-size character windows: they cut
sentences mid-thought, sever tables from their headers, and destroy the
provenance ("slide 17") that the product must show. M4 deliberately preserved
structural boundaries (slides, pages, headings, tables, notes) precisely so
chunking could respect them.

## Decision

### 1. Chunk along the structure M4 preserved

- **PPTX** — the slide is the semantic unit: one core chunk per slide
  (title + body), plus a separate chunk for each table (prefixed with the
  slide title) and for speaker notes. Locators: `{type, slide, title,
table?, notes?}`.
- **PDF** — one chunk per page (multiple `page_text` sections of the same
  page are regrouped first). Locators: `{type, page}`.
- **DOCX/TXT** — heading-scoped flow: a heading and its following
  paragraphs/lists accumulate into one chunk up to the size budget; each
  table becomes its own chunk with the nearest heading prefixed. Locators:
  `{type, sectionIndex, heading?, table?}`.

### 2. Size budget: ~480 tokens (chars/4 heuristic)

`MAX_CHUNK_TOKENS = 480` (1920 chars) fits every mainstream embedding model
comfortably and keeps retrieval hits focused on one idea. Token estimates use
the chars/4 heuristic — good enough for a budget; we deliberately avoid a
tokenizer dependency.

### 3. Overlap only at structural boundaries (spec G)

When an oversized unit must be split, splits happen at line (then word)
boundaries and each subsequent part carries the previous part's final line
(≤240 chars) as structural overlap, recorded as `part: N` in the locator.
Hard splits (a single enormous token with no boundary) carry **no** overlap —
duplicating arbitrary character runs adds noise, not continuity. There is no
blanket sliding-window overlap: structural chunks are already self-contained.

### 4. Tables stay tables (spec H)

Tables are chunked whole as pipe-delimited rows; when a table exceeds the
budget it is split at **row** boundaries with the header row repeated in
every part, so no row ever loses its column meaning. Table chunks carry the
slide title or nearest heading as context and `table: true` in the locator.

### 5. Deterministic and idempotent

Same sections in, same chunks out (ordinals, locators, and section ranges
included). Combined with the atomic `replace_source_chunks` RPC, re-indexing
converges instead of accumulating duplicates.

## Consequences

- Every chunk carries a human-usable locator; the product can always render
  "Adult Health Module 3 — slide 17" (spec F/R).
- `section_start`/`section_end` link each chunk to the inclusive
  `document_sections.sequence` range it was built from (M4 provenance link).
- A future tokenizer-accurate budget or semantic-similarity splitting can be
  introduced by bumping `EMBEDDING_VERSION`, which triggers re-indexing.
