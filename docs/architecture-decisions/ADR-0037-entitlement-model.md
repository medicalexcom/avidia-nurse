# ADR-0037: Capability-based entitlements, server-authoritative, flag-gated

- **Status:** Accepted
- **Date:** 2026-08-14
- **Milestone:** M14

## Context

M14 requires a central entitlement model (spec A/B), server-authoritative
checks (spec K), a genuinely useful free plan (spec L), and a defined
failure behavior when entitlements cannot be fetched (spec AW). The
Blueprint's pricing table is explicitly labeled hypotheses, and the second
core principle applies: learning data must never disappear on expiry.

## Decision

### 1. Two plans, capability-based checks

`free` and `pro` — no tier zoo (spec B). Features ask
`canUser('advanced_modes')`, never `user.plan === 'pro'`; the plan →
capability mapping lives in ONE place (`@avidia/entitlements`
`PLAN_DEFINITIONS`, mirrored by `get_my_entitlements()` in SQL,
`rules_version` 1). FREE keeps the core loop genuinely useful: course
uploads, adaptive study, patient simulation and analytics, limited to 1
active course and monthly usage caps (10 documents / 30 AI generations /
3 simulations). PRO levers are `advanced_modes` and `study_planner` plus
unlimited usage. **The numeric limits are engineering placeholders pending
founder pricing approval.**

### 2. The server is the only authority

`get_my_entitlements()` (SECURITY DEFINER) resolves the plan from
webhook-written subscription rows; FREE-plan limits are enforced by
database triggers on `courses`, `documents` and `simulation_sessions`
(with rate limits on the costly pipelines). The client's `canUser` renders
UI only — a tampered client can change what it draws, never what the
database permits (verified by authz sections 64–69).

### 3. Enforcement ships behind the `subscriptions` feature flag (default off)

All triggers no-op while the flag is false, so M0–M13 behavior (and its
entire test suite) is unchanged until billing is deliberately launched.
Usage counters record ALWAYS — cost visibility (spec W/X) does not wait for
monetization. Flipping one row launches enforcement without a deploy.

### 4. Failure behavior: bounded cache trust, UI fails open, server never does

When the entitlement fetch fails, the client trusts its last server payload
for at most 72 hours (`shouldTrustCachedEntitlements`; future-dated caches
are rejected against clock tampering), then renders permissively. The
tradeoff (spec AW): a UI that fails CLOSED would lock paying students out
of premium features during an outage; failing OPEN in the UI grants nothing
real, because every enforced limit lives in database triggers that do not
care what the client believes. A pirate can see a button; the server still
says no.

### 5. Expiry downgrades access, never data

`current_plan()` returning `free` changes what can be CREATED going forward
(and gates premium modes). Nothing is deleted or hidden: courses beyond the
FREE limit remain readable/archivable, mastery history stays, uploads stay
(core principle; spec O). Grace windows mirror provider reality: `past_due`
keeps access 7 days past the period end (case AY-F), cancel-at-period-end
keeps it through the paid period (case AY-E), unknown provider statuses
normalize to `expired` and never grant access.

## Consequences

- One rules version to update when pricing is finalized; no scattered
  plan checks to hunt down.
- The flag means M14 can merge fully tested with zero behavior change.
- The 72-hour trust window is a deliberate, documented ceiling on how long
  a canceled subscription can look active on a disconnected device.
