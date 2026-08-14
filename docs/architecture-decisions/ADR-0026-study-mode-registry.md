# ADR-0026: Study modes as a registry of filters over the existing bank

- **Status:** Accepted
- **Date:** 2026-08-13
- **Milestone:** M10

## Context

M10 adds five study modes (Rapid Response, Find the Danger, Who First?,
Medication Lab, Boss Battle — the blueprint's in-scope, Low–Medium
complexity set). The spec demands a shared activity contract feeding M8
normalized evidence (spec A), an extensible architecture without giant
conditionals (spec B), course grounding (spec N), a single mastery model
(spec O), and centralized evidence weighting (spec P) — while explicitly
forbidding a redesign of working M7–M9 systems.

## Decision

### 1. The shared activity contract is the pipeline that already exists

Every mode presents rows from `questions` (the validated M7 bank) inside a
`study_sessions` row and records answers through `submit_question_attempt`.
That RPC — with its server-side scoring and M8 mastery update — IS the
normalized `StudyActivity → result → evidence` contract: one question, one
scored attempt, one server-computed mastery delta. Because no mode invents
its own result shape, M8 cannot be fed distorted evidence, there is no
"game mastery" to reconcile (spec O), and the evidence weighting stays
exactly where M8 centralized and documented it (difficulty, cognitive
level, confidence, misconception factors in `@avidia/mastery` and migration
0008 — spec P). Response speed already has no mastery effect
(`RESPONSE_TIME_FACTOR` is neutral), which is precisely the bounded
behavior spec D requires of Rapid Response.

### 2. A mode is a pure registry entry: filter + seeded ordering

`features/modes/registry.ts` defines each mode as data: an
`includesQuestion(question, conceptType)` predicate over stored facts
(question type, difficulty, cognitive level, priority frameworks, concept
type — never text matching or AI guesses) plus a `buildOrder(pool, count,
seed)` producing a deterministic plan. Screens iterate the registry; adding
a sixth mode is one new entry and zero screen conditionals (spec B). All
business logic is pure and unit-tested outside React.

### 3. Game sessions use a FIXED seeded order

Unlike M9 adaptive sessions, mode sessions never re-rank mid-flight: a
drill has a shape (Boss Battle's Foundation → Application → Prioritization
→ Integrated rounds) that adaptation would destroy, and determinism keeps
results explainable. Adaptivity remains the adaptive mode's job; the modes
are complementary practice structures over the same bank.

### 4. Minimal persistence: five new `session_type` values, nothing else

Migration 0010 only extends the `study_sessions.session_type` check
constraint. Sessions, plans, attempts, and RLS are all reused unchanged
(spec AL). Mode sessions are not resumable in v1 (an honest, documented
limitation) — the M9 plan/resume machinery remains adaptive-only.

### 5. No specialized generation pipeline in v1

The validated bank already contains every ingredient the five modes need
(multiple-response danger questions, prioritization frameworks, medication
concepts, numeric calculations). When a course lacks them, the mode locks
with a guiding message (spec T) instead of triggering generation. If a
future milestone adds mode-targeted generation, it must flow through the
existing generation → schema validation → quality validation → persistence
→ use pipeline (spec AH); nothing in the registry design blocks that.

## Alternatives considered

- **A parallel "activities" table with per-mode result schemas.** Rejected:
  duplicates attempt truth, forces a second evidence path into M8, and
  violates spec Y's single-source rule and spec AL's minimal persistence.
- **Mode logic inside PracticeScreen conditionals.** Rejected: spec B
  forbids it; the registry keeps modes testable and additive.
- **LLM-orchestrated mode sessions.** Rejected: modes must work with the AI
  provider unavailable (spec AI); everything runs from the persisted bank.

## Consequences

- All five modes work offline-from-AI, are owner-scoped by existing RLS,
  and feed the one mastery model through the one scoring RPC.
- Boss Battle rounds shrink honestly when a bank cannot fill them.
- Partial credit remains the server's M7 scoring semantics; the client
  displays exactly what the server returns — no client-side scoring was
  added (spec Q is satisfied by not inventing credit the server never
  granted).
