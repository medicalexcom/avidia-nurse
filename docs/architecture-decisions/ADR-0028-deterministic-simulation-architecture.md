# ADR-0028: Deterministic simulation architecture — the LLM is never the engine

- **Status:** Accepted
- **Date:** 2026-08-14
- **Milestone:** M11

## Context

M11 adds a stateful virtual-patient simulation. The core principle of the
instruction is absolute: the LLM must NOT be the authoritative simulation
engine. Patient state, action validity, state transitions, critical events,
scoring, and outcomes must be structured, deterministic, validated,
testable, and versioned. At the same time, the project's standing security
architecture (ADR-0007/0020) requires that anything affecting stored
results be computed server-side, because the client bundle is fully
inspectable and RLS is the only trustworthy boundary.

## Decision

### 1. A pure rule interpreter, not a physiology model and not an AI

The simulation engine is a deterministic interpreter over declarative case
definitions: `applyAction(caseDef, state, action) → { state, events,
rejected }`. All clinical behavior — vital changes, finding reveals, lab
releases, deterioration, outcomes — is data in the case definition (rules
with triggers, conditions, and effects), never code paths per case and
never model inference. Same state + same action = same result, always.
This is what makes branch tests (spec BA), property tests (spec BB), and
replay (spec W) possible at all.

### 2. TypeScript is the executable specification; SQL is the authoritative runtime

The engine exists twice, deliberately, extending the ADR-0020/0022
double-maintenance contract:

- `packages/simulation` (TypeScript) is the pinned, exhaustively tested
  specification — pure functions, no I/O, safe for the web bundle, used by
  tests, the validation gate, and seed generation.
- Migration `0011` (plpgsql over jsonb) is the AUTHORITATIVE runtime: the
  `simulation_act` SECURITY DEFINER RPC interprets the same semantics
  server-side, because a client-side engine could be trivially tampered
  with to fabricate outcomes and mastery evidence.

Both carry `SIMULATION_ENGINE_VERSION = 1` and must be bumped in lockstep;
sessions pin the engine version they started under (spec AY), and
`start_simulation` refuses cases whose engine version it does not speak.

### 3. One transaction per action, no partial state (spec BC)

`simulation_act` performs reject-or-apply, history append, state persist,
and — on completion — scoring plus mastery evidence in a single
transaction under `FOR UPDATE`. Concurrent submissions serialize; a
crashed request leaves no half-written session. Rejections are audited as
rows but change nothing.

### 4. Sessions always terminate

The validation gate proves every case has a time-triggered `end` rule (or
equivalent guaranteed termination), and the property tests walk every
built-in case with pure waiting to prove it. Completed sessions reject
every further action, forever.

## Alternatives considered

- **LLM-adjudicated actions** ("ask the model what happens next"):
  explicitly forbidden by the instruction, and rightly — unreproducible,
  untestable, unversionable, and clinically unaccountable.
- **Client-side engine with server checkpointing:** rejected; the client
  could submit any state it liked. The server interprets; the client only
  renders (ADR-0007 pattern).
- **A single implementation in SQL only:** rejected; plpgsql is a poor
  medium for the hundreds of fine-grained semantic tests the engine needs.
  The TS mirror is the price of testability, and the sync is pinned by
  deterministic scenario timings both sides must reproduce.

## Consequences

Every mechanism exists twice and must be maintained twice — accepted
knowingly, with the TS suite as the contract. In exchange: full offline
determinism for tests, byte-stable replays, versioned semantics, and a
server that cannot be lied to about what happened to the patient.
