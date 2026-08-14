# ADR-0022: Mastery algorithm v1 — deterministic, bounded, versioned

- **Status:** Accepted
- **Date:** 2026-08-13
- **Milestone:** M8

## Context

M8 needs a per-concept mastery estimate that drives review scheduling and
recommendations. The spec's core principle is that THE LLM IS NOT THE
MASTERY ENGINE: every number must be deterministic, explainable, testable,
reproducible, and versioned (spec core principle, V, AB). A student's
mastery must never depend on which AI provider is configured, on network
weather, or on prompt phrasing — and no mastery data may ever be sent to an
AI provider (spec AE). The estimate must also be honest about uncertainty:
a 0–1 number internally, but never shown to students as fake precision
(spec B/AG), and "no evidence" must be a first-class state, not a zero
(spec C).

## Decision

### 1. A bounded, diminishing update rule (spec D/E)

Mastery is a single scalar `m ∈ [0, 1]` per user × course × concept
(spec A/AM), updated by a pure function of the previous aggregate and one
performance event:

- Correct: `m′ = m + min(GAIN_RATE · w · (1 − m), GAIN_CAP)` with
  `GAIN_RATE = 0.3`, `GAIN_CAP = 0.25`. Gains diminish as mastery rises —
  a strong concept is hard to inflate further.
- Incorrect: `m′ = m − min(DROP_RATE · w · max(m, DROP_FLOOR), DROP_CAP)`
  with `DROP_RATE = 0.4`, `DROP_FLOOR = 0.35`, `DROP_CAP = 0.3`. The floor
  makes early mistakes matter; the cap means no single question can erase
  a history of evidence.

`w` is a multiplicative weight clamped to `[0.25, 2.0]`, composed of three
transparent tables (spec F/G/H) that live in ONE config file (spec AJ):

- **Difficulty (spec F):** harder questions earn more when correct
  (easy 0.8 / moderate 1.0 / hard 1.25) and cost less when missed
  (inverted: easy 1.25 / moderate 1.0 / hard 0.8).
- **Cognitive level (spec G):** higher-order success counts more
  (recall 0.85 → prioritization 1.25 when correct); when incorrect the
  cognitive factor is neutral (1.0) — missing an analysis question is not
  worse evidence of a gap than missing a recall question.
- **Confidence (spec H):** calibration, never punishment for honesty. A
  confessed guess that happens to be right earns little (0.55); confident
  correctness earns a small bonus (certain 1.1). Confident wrongness costs
  the most (certain 1.15 when incorrect) because it signals a
  misconception; an honest "guessing" wrong costs the least (0.85). Absent
  confidence is neutral (1.0).

### 2. Response time is explicitly excluded in v1 (spec I)

`RESPONSE_TIME_FACTOR = 1.0` sits in the config with a comment explaining
why: time-per-question confounds reading speed, accessibility needs, and
interruptions with knowledge. Excluding it is a documented decision, not
an omission; a future version can weight it once there is evidence it
helps.

### 3. Misconception severity from confident errors (spec R)

A separate `misconceptionSeverity ∈ [0, 1]` rises only on
confident-incorrect answers (pretty_sure/certain) and decays on correct
ones. It never lowers mastery directly — it raises recommendation priority
(ADR-0024) so the misconception gets surfaced and practiced, with
non-judgmental wording.

### 4. Pure function, dual implementation, constant-for-constant

`updateMastery` in `@avidia/mastery` takes `(previousAggregate, event)` and
returns the new aggregate plus a delta breakdown. It reads no clock and
touches no database — `answeredAt` on the event drives every timestamp, so
replays are exact. The authoritative write path is SQL inside the
`submit_question_attempt` RPC (migration 0008), which mirrors `config.ts`
constant for constant; the authz harness asserts the RPC's stored numbers
against the TypeScript arithmetic to the sixth decimal, so the two
implementations cannot drift silently.

### 5. Versioning and migration strategy (spec AA/Z)

`MASTERY_ALGORITHM_VERSION = 1` is stamped on every `concept_mastery`
aggregate and every append-only `mastery_events` row. Changing any
constant or formula requires a version bump. Because events record the
full input (weights, before/after, confidence, correctness) per attempt,
a future version can either (a) apply v2 forward from a cut-over date, or
(b) deterministically replay a student's event history under v2 to
recompute aggregates — both auditable, neither requiring guesswork about
what v1 did.

## Consequences

- Every mastery number on screen or in the database is reproducible from
  the event log by hand with a calculator; support questions become
  arithmetic, not archaeology.
- The clamps mean mastery moves believably: roughly 4–6 solid correct
  answers to approach "strong" from nothing, and no single bad day zeroes
  a concept.
- Honesty is safe: marking "guessing" never hurts more than pretending
  confidence, so the confidence signal stays trustworthy.
- v1 deliberately ignores response time and inter-concept transfer in the
  update rule; those are future versions with their own version numbers.
