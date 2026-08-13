# ADR-0002: Workspaces monorepo with a platform-agnostic config package

- **Status:** Superseded in part by ADR-0005 (tooling: npm workspaces → pnpm + Turborepo, per
  Playbook §4). The structural boundaries below remain in force.
- **Date:** 2026-08-12
- **Milestone:** M0

## Context

The adaptive learning engine (mastery tracking, spaced repetition, simulation state machines) must
exist independently of both the UI and any LLM provider. Backend services will be added in later
milestones. We need a structure that enforces these boundaries without heavyweight tooling a
nontechnical founder could not maintain.

## Decision (as originally made, before the Playbook was available)

Use a plain npm workspaces monorepo:

- `apps/app` — the Expo application (UI only).
- `packages/config` — pure TypeScript, **no React, no Expo, no LLM SDKs**. Environment schema
  validation lives here today. Domain logic (adaptive learning engine, mastery models, spaced
  repetition scheduling) will live in dedicated Playbook packages (`packages/domain`,
  `packages/adaptive-engine`, …) added at their milestones so they are unit-testable and
  provider-independent by construction.
- Future workspaces are added only when their milestones arrive, not before.

npm workspaces was chosen because it ships with npm (zero extra tooling), is well supported by
Expo/Metro, and keeps mental overhead minimal.

## Supersession note (2026-08-12)

The AI Build Implementation Playbook v2 — received after M0 was executed — prescribes **pnpm
workspaces + Turborepo** (`pnpm-workspace.yaml`, `turbo.json`) as part of the repository contract.
ADR-0005 records the migration, performed during the same-day reconciliation while the repo held
only two workspaces (the cheapest possible time to switch). The `.npmrc` sets
`node-linker=hoisted` for Expo/Metro compatibility.

## Consequences

- Dependency isolation between UI and domain logic is structural, not aspirational.
- `packages/config` is consumed as TypeScript source (`main: src/index.ts`); Metro and Jest compile
  it directly. A build step can be added if a non-Metro consumer (e.g. the backend) needs it.
- Root-level scripts (`typecheck`, `test`, `build:web`) fan out across workspaces via Turborepo;
  `lint` and `format` run repo-wide directly, so CI stays simple.
