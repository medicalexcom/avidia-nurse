# ADR-0031: AI boundaries in the simulation — scripted, optional, never load-bearing

- **Status:** Accepted
- **Date:** 2026-08-14
- **Milestone:** M11

## Context

The M11 instruction is categorical: the LLM must not be the authoritative
simulation engine, and no action may require a synchronous LLM call
(spec BD). At the same time the product has AI features elsewhere
(M6/M9 generation, M10 conversation modes), so the boundary needs to be
drawn precisely: what may AI never touch in the simulation, and where
could it safely appear later?

## Decision

### 1. No synchronous LLM call anywhere in the action loop (spec BD)

Submitting an action calls exactly one RPC, `simulation_act`, which is
pure plpgsql over the case definition and state. No model is consulted
for validity, consequences, dialogue, scoring, or outcomes — ever. Action
latency is one database round-trip, the loop works with zero AI keys
configured, and every result is reproducible byte-for-byte (spec W).

### 2. Patient dialogue is scripted and deterministic (spec AG/AH/AI)

"Ask the patient" presents a finite set of authored prompts from the case
definition; each maps to an authored response, optionally gated on state
(e.g. a question about chest pain yields more once the finding is
revealed, or changes as the patient deteriorates). This is a deliberate
product decision, not just an engineering one: scripted dialogue is
clinically reviewable, cannot hallucinate symptoms that contradict the
true state, and cannot leak hidden findings — the same no-leak contract
as the rest of the client view (spec N).

### 3. The simulation is fully functional without AI (spec AI)

Library, sessions, actions, dialogue, deterioration, outcomes, scoring,
debrief, replay, and mastery evidence all work with no AI configuration
present. There is no degraded mode; the deterministic path IS the product.

### 4. Where AI may appear later — and only there

Future milestones may use AI strictly OUTSIDE the authoritative loop:
drafting new case definitions offline (which must still pass the
ADR-0030 validation gate and human review before ACTIVE), or narrative
polish in the debrief clearly derived from the deterministic score record.
AI output may never enter `simulation_act`, mutate state, or produce
scores or mastery evidence. The engine/AI boundary is the RPC surface.

## Alternatives considered

- **LLM-generated patient replies constrained by state:** rejected for v1;
  even "constrained" generation can contradict the chart, leak hidden
  findings phrasing, and is untestable against golden transcripts. The
  playbook scopes M11 to "state engine, action loop, debrief."
- **Async AI hints during a session:** rejected for v1; the hint feature
  shipped is a static nursing-process prompt (tracked as `hint_used`),
  which needs no model and cannot mislead.

## Consequences

Students can trust that the patient's behavior is authored clinical
content, instructors can audit every possible interaction, and tests can
assert exact transcripts. The trade-off is expressiveness: the patient
only says what was written. That constraint is accepted as a feature —
in a safety-training context, an improvising patient is a liability.
