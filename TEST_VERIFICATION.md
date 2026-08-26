# Test Verification — Skill #1, #2, #3 Integration

This document tracks the verification of the end-to-end integration test
suite that proves Skill #1 (Concept Prerequisites & Mastery Gating), Skill #2
(Semantic Chunking & Context Window Optimization), and Skill #3 (Multi-Level
Question Generation / Bloom's Taxonomy) work correctly together.

## What was added

| File | Purpose |
| --- | --- |
| `packages/assessment/src/__tests__/skill-integration.test.ts` | 21-test integration suite (Jest) exercising all three skills individually and together |
| `scripts/test-skills.sh` | Executable helper to run the suite, optionally filtered to one skill or the end-to-end block |
| `TEST_VERIFICATION.md` | This checklist |

The suite imports only existing, already-shipped code:

- `@avidia/mastery` — `checkPrerequisites`, `detectPrerequisiteCycles`,
  `topologicalSortByPrerequisites`, `PREREQUISITE_MASTERY_THRESHOLD`,
  `initialAggregate`, `masteryState` (Skill #1)
- `@avidia/rag` — `chunkSections`, `estimateTokens`, `splitWithOverlap`,
  `MAX_CHUNK_TOKENS`, and the `CONCEPT_BOUNDARY_MARKERS` /
  `RELATIONSHIP_MARKERS` vocabularies (Skill #2)
- `packages/assessment/src/blooms.ts` (already in-package) — `BLOOMS_LEVELS`,
  `MASTERY_BAND_TARGETS`, `getLevelGroup`, `getTargetsForMastery`,
  `getProgressionPath`, `meetsLevelTargets`, `calculateBlomsLevelCoverage`,
  `recommendNextLevel`, `generateBlomsPromptSuffix` (Skill #3)
- `@avidia/domain` — `ExtractedSection`, `COGNITIVE_LEVELS`, `CognitiveLevel`

`@avidia/mastery` and `@avidia/rag` were added as `workspace:*` dependencies
of `@avidia/assessment` (see `packages/assessment/package.json`) so these
already-existing monorepo packages can be imported from the new test file.
No third-party/external packages were added.

## Verification checklist

- [x] `packages/assessment/src/__tests__/skill-integration.test.ts` exists
      and contains 21 tests across four `describe` blocks:
      - [x] `SKILL #1: Concept Prerequisites & Mastery Gating` — 5 tests
      - [x] `SKILL #2: Semantic Chunking & Context Window Optimization` — 4 tests
      - [x] `SKILL #3: Multi-Level Question Generation (Bloom's Taxonomy)` — 9 tests
      - [x] `END-TO-END: All Skills Integrated` — 3 tests
- [x] All tests use existing exported types/functions — no new production
      code, no mocks, no network/database access.
- [x] `pnpm --filter @avidia/assessment test` passes for the new suite
      (`21 passed, 21 total`).
- [x] `scripts/test-skills.sh` is executable (`chmod +x`) and supports
      `1`, `2`, `3`, `e2e`, and `all` (default) filters via Jest's `-t` flag.
- [x] Adding `@avidia/mastery` and `@avidia/rag` as workspace dependencies of
      `@avidia/assessment` does not affect any other package (they are
      already published workspace packages; `pnpm-lock.yaml` updated
      accordingly).
- [x] Pre-existing `@avidia/assessment` test failures (`gateway.test.ts`,
      `validate.test.ts`, `schema.test.ts`) are unrelated to this change —
      confirmed by running the suite before and after these changes.

## How to run

```bash
# From the repo root, after `pnpm install`:
scripts/test-skills.sh          # run all 21 skill integration tests
scripts/test-skills.sh 1        # Skill #1 only (prerequisites/gating)
scripts/test-skills.sh 2        # Skill #2 only (semantic chunking)
scripts/test-skills.sh 3        # Skill #3 only (Bloom's Taxonomy)
scripts/test-skills.sh e2e      # end-to-end integration tests only

# Or directly with Jest:
pnpm --filter @avidia/assessment test -- src/__tests__/skill-integration.test.ts
```

## Test coverage summary

### SKILL #1 — Concept Prerequisites & Mastery Gating (5 tests)
1. Blocks a concept when all prerequisites are below the 70% mastery
   threshold and flags them as blocking (strength ≥ 8).
2. Unlocks the concept once every prerequisite reaches/exceeds the
   threshold.
3. Treats a low-strength (< 8) prerequisite as advisory rather than
   blocking, even at low mastery.
4. Confirms a valid prerequisite map has no cycles.
5. Detects an injected cycle and, on the original acyclic map, produces a
   topological order that always places prerequisites before dependents.

### SKILL #2 — Semantic Chunking & Context Window Optimization (4 tests)
1. Keeps a full cause → effect reasoning chain within a single chunk and
   flags it via `semanticContext.hasRelationshipChain`.
2. Extracts concept terms (e.g. "Glucose Metabolism", "Diabetic
   Ketoacidosis") into `semanticContext.containsConceptTerms` for
   cross-reference indexing.
3. Confirms oversized text is split within the token budget (with a bounded
   20% context-preservation allowance).
4. Confirms the concept-boundary and relationship-marker vocabularies used
   by the chunker are present and exported.

### SKILL #3 — Multi-Level Question Generation / Bloom's Taxonomy (9 tests)
1. Every `CognitiveLevel` (including the nursing-specific
   `prioritization`) maps to a valid Bloom's level group.
2. Unassessed students are targeted with foundational (`recall`,
   `understanding`) questions only.
3. Developing-mastery students are targeted with `application`/`analysis`.
4. Strong-mastery students are targeted with `analysis`/`evaluation`/
   `synthesis`.
5. All four mastery bands have monotonically increasing mastery-range
   floors.
6. The default progression path runs foundational → advanced.
7. `meetsLevelTargets` correctly validates a generated question's cognitive
   level against a mastery band's targets.
8. `calculateBlomsLevelCoverage`/`recommendNextLevel` recommend the
   least-covered level next.
9. `generateBlomsPromptSuffix` requests every level in a Bloom's level
   group with the requested minimum count.

### END-TO-END — All Skills Integrated (3 tests)
1. A gated concept (DKA) with an unmastered prerequisite (Glucose
   Metabolism) is (a) correctly chunked with concept-term cross-references
   (Skill #2), (b) correctly blocked by prerequisite gating (Skill #1), and
   (c) correctly targeted with foundational questions for the still-low
   prerequisite (Skill #3).
2. Once the prerequisite clears the mastery threshold, the gate opens
   (Skill #1) while question targeting escalates appropriately for each
   concept's own mastery band (Skill #3).
3. A full prerequisite-ordered study plan (Skill #1's topological sort) is
   walked concept-by-concept, verifying every concept's mastery snapshot
   maps to a valid Bloom's target band (Skill #3), and that the final
   concept's gate is satisfied once its prerequisites clear the threshold.
