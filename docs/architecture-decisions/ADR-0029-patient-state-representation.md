# ADR-0029: Patient state representation — structured, bounded, and hidden by default

- **Status:** Accepted
- **Date:** 2026-08-14
- **Milestone:** M11

## Context

The simulation needs a patient state that is explicit (spec C), clinically
bounded (spec J), supports hidden information the student must actively
uncover (spec M/N), and can be persisted, resumed, and replayed byte-for-
byte (spec V/W/X). Free-text state is untestable; per-case bespoke state
shapes would make the interpreter impossible.

## Decision

### 1. One typed `PatientState` shape for every case

State is a single structured record: engine/case versions, current phase,
simulated time, true vitals, the last OBSERVED vitals snapshot, per-finding
`{present, revealed}` flags, per-lab `{released, value, flag}`, patient
statements, safety flags, deterioration level, fired-rule ids, pending
schedules, the append-only action log, and the completion record. Cases
differ only in their DATA (which findings, which rules), never in state
shape — so one interpreter, one redactor, and one persistence column serve
every case.

### 2. True state vs. observed state are different things (spec M)

Vitals the student sees are a snapshot taken when they obtained vitals,
stamped with its simulation time. The true vitals keep evolving underneath;
an old snapshot never silently updates. This makes reassessment a real
clinical decision with a real cost instead of a free live dashboard, and
the UI labels stale sets explicitly.

### 3. Findings are present-and-hidden until uncovered (spec M/N)

Every finding carries `present` (what is true) and `revealed` (what the
student has discovered) separately. Focused assessments reveal only present
findings in the assessed system; dialogue answers can be gated on findings
being revealed first. The redacted `clientView` — the ONLY payload a device
receives mid-session — contains revealed findings only, and the server-side
column grants make the raw `state` jsonb unselectable, so hidden content
cannot leak through the UI, telemetry, or any client-accessible payload.
The invariant tests serialize the client view and assert unrevealed finding
text never appears in it.

### 4. Vitals are clamped to hard physiologic bounds (spec J)

`PHYSIOLOGIC_BOUNDS` (HR 20–220, SpO2 50–100, etc.) clamp every vital
after every effect, intersected with any tighter per-effect min/max. No
rule stack, however authored, can produce an SpO2 of 3% or a negative
heart rate — bounds are enforced by the interpreter, not by authoring
discipline.

### 5. Stored as jsonb, interpreted server-side

The state column is jsonb with column-level grants excluding it from
clients entirely. Postgres interprets it directly (migration 0011) rather
than round-tripping through an app server; the TS types are the schema
documentation and the tests are its contract.

## Alternatives considered

- **Normalized relational state (a row per finding per session):**
  rejected — the state is read and written as a unit inside one
  transaction, versioned as a unit, and replayed as a unit; shredding it
  across tables buys nothing but join complexity.
- **Client-visible state with a "hidden" flag:** rejected outright; spec N
  requires hidden information never REACH the client, not merely be
  unstyled.

## Consequences

Resume is trivial (read one column), replay is exact, and every hidden-
information guarantee is enforceable by grant and provable by test. The
cost is that state-shape changes require an engine version bump and
lockstep TS/SQL edits — intended friction for a safety-relevant format.
