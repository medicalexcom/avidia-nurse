# ADR-0002: npm workspaces monorepo with a platform-agnostic core package

- **Status:** Accepted
- **Date:** 2026-08-12
- **Milestone:** M0

## Context

The adaptive learning engine (mastery tracking, spaced repetition, simulation state machines) must
exist independently of both the UI and any LLM provider. Backend services will be added in later
milestones. We need a structure that enforces these boundaries without heavyweight tooling a
nontechnical founder could not maintain.

## Decision

Use a plain **npm workspaces** monorepo (no Nx/Turborepo/pnpm for now):

- `apps/student` — the Expo application (UI only).
- `packages/core` — pure TypeScript domain logic: **no React, no Expo, no LLM SDKs**. Environment
  schema validation lives here today; the adaptive learning engine, mastery models, and spaced
  repetition scheduling will live here in later milestones so they are unit-testable and
  provider-independent by construction.
- Future workspaces: `apps/api` (backend), `packages/schemas` (shared structured-output/API
  schemas) — added when their milestones arrive, not before.

npm workspaces was chosen because it ships with npm (zero extra tooling), is well supported by
Expo/Metro, and keeps mental overhead minimal. Task-runner tooling (Turborepo etc.) can be layered
on later if build times demand it.

## Consequences

- Dependency isolation between UI and domain logic is structural, not aspirational.
- `packages/core` is consumed as TypeScript source (`main: src/index.ts`); Metro and Jest compile
  it directly. A build step can be added if a non-Metro consumer (e.g. the backend) needs it.
- Root-level scripts (`lint`, `typecheck`, `test`) fan out across workspaces so CI stays simple.
