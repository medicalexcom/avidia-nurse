# ADR-0004: M0 implemented from stated requirements; spec documents pending

- **Status:** Resolved 2026-08-12 — spec documents received; reconciliation performed (see ADR-0005)
- **Date:** 2026-08-12
- **Milestone:** M0

## Context

Three specification documents govern this project, in order of authority:

1. `Avidia_Nurse_AI_Build_Implementation_Playbook_v2.docx` (implementation contract)
2. `Avidia_Nurse_Product_and_Architecture_Blueprint_v2.docx`
3. `Avidia_Nurse_AI_Powered_ABSN_Straight_A_Study_System.docx`

At the time M0 was executed, none of the three documents were available: the project's `/docs`
location was empty and the `medicalexcom/avidia-nurse` GitHub repository contained no commits.

## Decision

M0 was implemented strictly from the founder's written M0 requirements (Expo + Expo Web + TypeScript
single app, monorepo workspaces, lint/format, tests, env validation, CI, README, worklogs, ADRs,
no backend/auth/AI/billing). Every judgment call not covered by those requirements is recorded in
ADR-0001 through ADR-0003.

## Consequences / follow-up (required)

When the three documents are provided:

1. Reconcile the repository structure against the Playbook's prescribed monorepo layout.
2. Verify naming, milestone boundaries, and tooling choices match the Playbook.
3. Update or supersede ADRs 0001–0003 where the Playbook dictates otherwise.
4. Store the documents in `docs/` (or the location the Playbook prescribes) so future milestones
   are grounded in the actual contract.

No M1 work should begin until this reconciliation happens.

## Resolution (2026-08-12)

All three documents were received the same day. The reconciliation audit was performed against the
Playbook (authority 1), Blueprint (authority 2), and Study System (authority 3). Corrections applied
are recorded in ADR-0005; the documents themselves now live in `docs/product/`. This ADR is closed.
