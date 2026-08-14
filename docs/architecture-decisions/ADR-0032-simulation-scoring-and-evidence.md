# ADR-0032: Simulation scoring and evidence — deterministic criteria, one mastery model

- **Status:** Accepted
- **Date:** 2026-08-14
- **Milestone:** M11

## Context

A completed simulation must produce a score that is deterministic and
explainable (spec S), aligned with the NCSBN Clinical Judgment Measurement
Model (spec O), and it must feed the existing M8 mastery system rather
than growing a parallel "simulation mastery" (spec T/U). Nothing about
scoring may involve model inference — students and instructors must be
able to see exactly why every point was or was not earned.

## Decision

### 1. Named criteria over six CJMM dimensions (spec O/S)

Each case authors scoring criteria — each with an id, human label, point
value, CJMM dimension (recognize cues, analyze cues, prioritize
hypotheses, generate solutions, take actions, evaluate outcomes), and a
deterministic predicate over the final state and action log (action taken,
taken before a deadline, taken before/after another action, finding
revealed, outcome reached). `scoreSession` evaluates every criterion and
returns earned/possible totals per dimension plus a per-entry breakdown,
alongside missed critical actions (spec Q) and unsafe actions taken
(spec R). `SIMULATION_SCORE_VERSION = 1` stamps every stored score;
algorithm changes bump the version rather than silently reinterpreting
old sessions.

### 2. The debrief shows the work (spec AQ)

Because every entry is a named criterion with a boolean result and a point
value, the debrief can render the full ledger: each criterion ✓/✗, points,
per-dimension subtotals, missed criticals, and unsafe actions framed as
consequences to rethink rather than shaming (spec R). The UI states
explicitly that nothing is judged by AI.

### 3. One mastery model: normalize into M8 evidence (spec T/U)

At completion — in the same transaction as scoring (spec BC) — the score
is normalized into the SAME `PerformanceEvent` shape M8 uses for question
attempts, via the case's `conceptMappings`. For each mapped concept, the
earned/possible ratio across its mapped dimensions is computed;
`EVIDENCE_CORRECT_THRESHOLD = 0.65` decides `isCorrect`. Events carry the
mapping's authored difficulty and cognitive level, null confidence (the
student never self-rates in a simulation), and flow through the
centralized ADR-0022 v1 mastery constants — no bespoke weighting.

### 4. Silence over invention

A concept whose mapped dimensions carry no scoreable points in that case
yields NO evidence at all. Emitting a fabricated "correct" (or "wrong")
signal from zero information would poison mastery estimates; the honest
output is nothing. Likewise, abandoned sessions produce no score and no
evidence (spec V) — only completed sessions speak.

## Alternatives considered

- **A separate simulation-mastery track:** explicitly forbidden by spec T,
  and rightly — two models of the same concept would disagree and neither
  would be authoritative for the M8 study loop.
- **LLM-graded performance narratives:** rejected; unexplainable,
  unreproducible, and unversionable. The recommendations list in the
  debrief is likewise deterministic (derived from missed criteria).
- **Per-action mastery updates during the session:** rejected; partial
  sessions would leak half-informed evidence, and spec BC requires
  completion-time, single-transaction application.

## Consequences

Every stored score is reproducible from the action log (spec W replay),
every mastery movement from a simulation is traceable to named criteria,
and the M8 review scheduler consumes simulation evidence with zero new
code paths. The cost is authoring discipline: criteria and concept
mappings must be written per case — enforced by the ADR-0030 validation
gate, which rejects unknown concept keys and unmapped dimensions.
