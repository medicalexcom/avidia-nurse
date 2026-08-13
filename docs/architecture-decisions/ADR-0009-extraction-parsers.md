# ADR-0009: Deterministic extraction parsers — library selection and no-AI rule

- **Status:** Accepted
- **Date:** 2026-08-12
- **Milestone:** M4

## Context

M4 must extract usable, ordered, provenance-preserving text from PDF, PPTX,
DOCX and TXT course materials. The spec is explicit: use mature deterministic
parsers, never an LLM, for ordinary text extraction; produce no XML garbage
or layout metadata as content; and do not perform OCR by default. The parsers
must run in Node (the background worker) and under Jest (CJS toolchain), and
must not require native binaries that complicate CI.

## Decision

### PDF: `pdfjs-dist` (PDF.js), legacy build, pinned to 3.11.174

Mozilla's PDF.js is the most battle-tested pure-JavaScript PDF text
extractor in existence (it powers Firefox's viewer). `getTextContent()`
yields per-page text items with `hasEOL` markers, which is exactly the
page-provenance model M4 needs, and it cleanly distinguishes
`PasswordException` (→ our `encrypted` code) from structural corruption
(→ `malformed`).

The version is pinned **exactly** to 3.11.174: it is the last release whose
`legacy/build/pdf.js` is CommonJS. v4+ is ESM-only, which the current
babel-jest CJS test toolchain cannot load. The pin is a documented limitation;
upgrading is a test-infrastructure task, not a parser rewrite. We disable
eval support and font rendering (`isEvalSupported: false`,
`disableFontFace: true`) since we only read text.

Security note (post-M4 reconciliation): the pinned version is within the
advisory range of CVE-2024-4367 (arbitrary JavaScript execution when
rendering a malicious PDF's fonts). Our usage does not render — the worker
only calls `getTextContent()` — and `isEvalSupported: false` is Mozilla's
documented mitigation, which disables the vulnerable eval path entirely.
The residual risk is accepted until the v4+ upgrade (blocked on the ESM
test-toolchain task above). pdfjs-dist's optional `canvas` dependency (a
native Node rendering backend we never invoke, whose install chain pulled
in outdated `node-pre-gyp`/`tar`) is excluded via
`pnpm.ignoredOptionalDependencies` in the root `package.json`.

Rejected: `pdf-parse` (thin, stale wrapper around old pdf.js); native
binaries like `poppler`/`mupdf` (CI/deployment friction, no benefit for
text-based PDFs).

### PPTX / DOCX: `jszip` + `fast-xml-parser` with a small custom OOXML layer

OOXML files are zip archives of XML parts. Rather than adopting a heavy
converter, we read the archive with `jszip` and parse parts with
`fast-xml-parser` in `preserveOrder` mode, then walk the node tree with ~80
lines of shared helpers (`packages/ingestion/src/ooxml.ts`). Only `a:t` /
`w:t` text nodes are ever read as content, so drawing coordinates, theme
data and other XML machinery structurally cannot leak into sections.

This bought us the things converters do not expose reliably:

- PPTX slide order from `p:sldIdLst` (the authoritative presentation order),
  not from file names;
- placeholder-type awareness (title vs body vs slide-number/footer chrome);
- speaker notes via the notesSlide relationship;
- bullet outline levels (`a:pPr lvl`, `w:ilvl`) preserved as indentation;
- tables as rows/columns rather than flattened prose.

Rejected: `mammoth` (DOCX→HTML only, loses list levels and provenance, no
PPTX); `officeparser`/`textract` (flatten everything to one string —
provenance is the core M4 requirement); writing a full OOXML schema model
(unnecessary; we consume four element families).

### TXT: hand-rolled normalization, conservative structure detection

Normalization (BOM strip, newline unification, control-char removal,
whitespace collapse) plus paragraph splitting on blank lines. A paragraph is
promoted to a heading only when it is a single line ≤ 80 chars and either
markdown-`#` or ALL CAPS with no terminal punctuation. Anything ambiguous
stays a paragraph: we do not invent structure that is not clearly present.

### No AI, no OCR

No LLM/AI service is called anywhere in extraction (spec Q) — the parsers
above are sufficient for every text-based format. OCR is not attempted:
a PDF with pages but effectively no extractable text (< 25 chars total)
fails with the explicit code `ocr_required` (spec L). The Playbook does not
assign OCR to M4; when it is scheduled, it becomes a new extraction branch
behind the same `extractDocument` interface.

### Test fixtures are generated, not committed

Fixture builders (`fixtures.ts`) construct a minimal valid PDF by hand
(objects, xref, text operators) and minimal PPTX/DOCX archives with JSZip,
from known fictional nursing content. No binary files in the repository, no
copyrighted material, fully deterministic tests (spec S).

## Consequences

- Extraction is pure computation in `packages/ingestion` — testable without
  any infrastructure, reusable by any runtime.
- The pdfjs pin must be revisited when the test toolchain moves to ESM.
- Complex real-world documents (multi-column PDFs, text boxes with unusual
  nesting) may extract imperfectly; failure modes are explicit codes, never
  silent empty content, and parsers can be improved behind a stable
  interface.
