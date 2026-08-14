# ADR-0030: Case definition format — declarative data behind a validation gate

- **Status:** Accepted
- **Date:** 2026-08-14
- **Milestone:** M11

## Context

The engine (ADR-0028) is a generic interpreter, so all clinical content —
who the patient is, what is wrong, what actions exist, what happens when —
must live in a case definition (spec A/F/G/AP). Cases are safety-relevant
content: an authoring mistake (an unreachable outcome, a session that never
ends, a concept key that does not exist) must be caught before a student
ever sees the case, not discovered in production (spec AB).

## Decision

### 1. Cases are declarative JSON-shaped data, never code

A `SimulationCase` contains: identity and versions (`caseKey`,
`caseVersion`, `engineVersion`), presentation metadata (title, description,
difficulty, scenario type, estimated duration), the fictional patient (spec
B — invented names, no real-person data), initial vitals, findings (each
`present` at start or made present later by rules), labs, medication
orders, the action catalog (controlled, finite, typed — spec E/F), scripted
dialogue prompts with optional reveal-gating (spec AG/AH), patient
statements, rules (trigger + conditions + effects — spec G), outcomes
(spec AP), critical actions (spec Q), unsafe action classifications
(spec R), scoring criteria (spec S), and concept mappings (spec T).
There is no per-case code path anywhere in the engine.

### 2. `validateCase` is a hard gate, not a linter

Every case must pass the validator before it can be seeded as ACTIVE
(spec AB). The validator proves, statically and by bounded execution:
referential integrity (every id referenced by rules, criteria, outcomes,
and dialogue exists), physiologic sanity of initial vitals and effect
targets (spec J), guaranteed termination — a time-triggered rule chain
that always ends the session (spec BC of ADR-0028 §4), reachability of
every outcome, and honest concept mappings (concept keys must resolve
against the knowledge package's catalog; unknown keys are an error, not a
silent skip). A case that fails validation cannot be seeded at all.

### 3. The seed migration is generated, and a test pins the sync

`buildSeedSql()` runs every built-in case through `validateCase` and emits
migration `0012_simulation_seed.sql` (dollar-quoted jsonb upserts keyed on
`case_key`). A sync-pin test regenerates the SQL and byte-compares it to
the checked-in migration, failing the suite if the library and the
migration ever drift; `UPDATE_SIM_SEED=1` regenerates it intentionally.
Content changes therefore always flow: edit case → tests fail → regenerate
→ review diff — never hand-edited SQL.

### 4. Small library, versioned cases (spec AF/AX)

The v1 library is three cases (post-op pulmonary embolism, hypoglycemia,
hyperkalemia) authored to full depth — hidden findings, deterioration
branches, unsafe paths with consequences, scripted dialogue — rather than
many shallow ones. Quality over quantity is the explicit spec instruction.
`caseVersion` is bumped on any content change; sessions pin the version
they started under, so an in-flight session is never mutated by a reseed.

Amended in the M11 reconciliation: pinning is enforced by a full
definition SNAPSHOT copied into `simulation_sessions.definition` at start
(server-only column, same grant posture as the case row's definition).
Because seed upserts replace `simulation_cases.definition` in place,
merely storing the version number was not enough — the RPCs originally
re-read the live row, which would have let a reseed silently reinterpret
in-flight and historical sessions. All session RPCs now interpret against
the snapshot; only display metadata comes from the live case row.

## Alternatives considered

- **Code-defined cases (a TS module per case with callbacks):** rejected;
  cannot be stored in a database column, cannot be validated as data,
  and reintroduces per-case code paths the interpreter exists to prevent.
- **Runtime-only validation (validate on load):** rejected; the gate must
  fail at authoring/CI time. A student should never be the one who
  discovers a case is invalid.
- **Hand-written seed SQL:** rejected; unreviewable duplication that would
  drift from the TS library. Generation plus a sync-pin test makes drift
  a test failure.

## Consequences

Authoring a case requires no engine knowledge beyond the schema, and every
authored case carries machine-checked guarantees of termination,
reachability, and referential honesty. The cost is a strict schema —
content that does not fit the rule model (free-form improvisation) simply
cannot be expressed, which is the point.
