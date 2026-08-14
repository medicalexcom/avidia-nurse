# Avidia Nurse

Avidia Nurse is a commercial adaptive nursing-education platform for ABSN/BSN students. One
cross-platform student application (iOS, Android, and web/desktop) delivers course-material-grounded
study tools, persistent mastery tracking, spaced repetition, and stateful patient simulations —
powered by AI but never dependent on any single AI provider.

**Current milestone: M8 — Adaptive Mastery Engine and Intelligent Study Scheduler.** Every
scored answer now updates a per-concept mastery model — and THE LLM IS NOT THE MASTERY ENGINE:
all mastery math is deterministic, versioned (`algorithm_version = 1`), unit-tested code that
runs identically with zero AI configuration, and no mastery data ever leaves the student's own
database rows. The pure `@avidia/mastery` package implements bounded diminishing updates weighted
by difficulty, cognitive level, and confidence calibration (honesty about guessing is never
punished; confident errors raise a misconception signal), explainable spaced repetition on a
fixed, visible interval ladder (1 day → 1 month — no SM-2 opacity), five non-stigmatizing
mastery states (a new concept is "New", never "failing"), and a versioned priority model
(exam proximity × weakness × forgetting risk × course emphasis × misconception × transfer need)
whose reason codes ARE the explanation — no LLM writes them. The scoring RPC applies the same
arithmetic transactionally (constant-for-constant mirror, idempotent per attempt, append-only
audit events), and the app gains a minimal study dashboard (next exam countdown, ONE recommended
action with honest reasons, coarse state groups — never a percentage or prediction) plus an
adaptive session mode that deterministically orders real questions from the persisted bank with
diversity bounds. Progress analytics, gamification, and predictions remain later milestones.

## Repository structure

```
avidia-nurse/
├── apps/
│   ├── app/                # The single cross-platform student app (Expo / React Native / Expo Web)
│   │   ├── app/            # expo-router routes: (auth) sign-in/up, (app) authenticated shell
│   │   ├── app.json        # Expo configuration (iOS/Android/web targets)
│   │   └── src/
│   │       ├── config/     # Validated environment configuration
│   │       ├── lib/        # Supabase client (session persistence, token refresh)
│   │       ├── features/   # auth, profile, courses, materials, concepts, practice, study
│   │       └── ui/         # Theme, shared components, responsive navigation shell
│   └── worker/             # Background worker (service role, Node/tsx): extracts queued
│                           # documents into sections, chunks + embeds ready documents into
│                           # source_chunks, extracts nursing concepts into the course
│                           # knowledge model, then generates validated practice questions;
│                           # includes the internal retrieval CLI
├── packages/
│   ├── config/             # Platform-agnostic shared configuration (no React, no LLM deps)
│   ├── domain/             # Pure domain logic: validation, timezone-safe time math, exam
│   │                       # countdowns, section/provenance model, concept taxonomy and
│   │                       # state machines
│   ├── ingestion/          # Deterministic PDF/PPTX/DOCX/TXT extraction (no AI, no network)
│   │                       # plus in-memory test-fixture builders
│   ├── knowledge/          # Concept extraction: normalization/dedup, strict schema
│   │                       # validation, provider-agnostic AI gateway, refinement,
│   │                       # fingerprint cost gate, batching, nursing eval fixtures
│   ├── rag/                # Semantic chunking, embedding providers (provider-agnostic),
│   │                       # course-scoped retriever, grounding-context builder, eval set
│   ├── assessment/         # Question engine: strict item schema + validation pipeline,
│   │                       # provider-agnostic generation gateway, deterministic scoring,
│   │                       # content-hash dedup, fingerprint cost gate, session mixing,
│   │                       # synthetic nursing eval fixtures
│   └── mastery/            # Pure adaptive mastery engine (no AI, no DB, no clock reads):
│                           # versioned update rule, explainable spaced-repetition ladder,
│                           # mastery states, exam urgency, priority + recommendation
│                           # reason codes, seeded deterministic question selection
├── docs/
│   ├── product/                 # The three governing specification documents
│   ├── architecture-decisions/  # ADRs — why the architecture is the way it is
│   ├── api/                     # API documentation (populated with the backend milestone)
│   ├── prompts/                 # Prompt templates (populated with the AI milestone)
│   ├── runbooks/                # Operational runbooks (populated as services appear)
│   └── worklogs/                # Per-milestone worklogs (what was done and why)
├── pnpm-workspace.yaml          # pnpm workspace definition
├── turbo.json                   # Turborepo task pipeline
└── .github/workflows/           # CI: format, lint, typecheck, test, web build, secret scan
```

## Prerequisites

- Node.js 20 or newer (22 recommended)
- pnpm 10 (via corepack: `corepack enable && corepack prepare pnpm@10.17.0 --activate`)
- For iOS/Android device testing: the [Expo Go](https://expo.dev/go) app, or Xcode / Android Studio
  for simulators

## Getting started

```bash
pnpm install               # install all workspace dependencies
cp .env.example .env       # optional: local environment overrides (never commit .env)

pnpm run web               # start the app in a web browser
pnpm --filter @avidia/app start   # start Metro; press i for iOS, a for Android, w for web
```

## Quality checks

```bash
pnpm run lint              # ESLint across the whole repo
pnpm run format:check      # Prettier formatting check (format with: pnpm run format)
pnpm run typecheck         # TypeScript, all workspaces (via Turborepo)
pnpm test                  # Jest, all workspaces (via Turborepo)
pnpm run build:web         # production web export (apps/app/dist)
pnpm run test:authz        # RLS/authorization checks against a real Supabase project
                           # (prints SKIPPED when Supabase secrets are not configured)
```

All of these run in CI on every push and pull request.

## Environment variables and secrets

Client configuration uses Expo's `EXPO_PUBLIC_*` convention and is validated at startup with a
schema (`packages/config/src/env.ts`). See `.env.example`.

**Never put secrets in this repository or in any `EXPO_PUBLIC_*` variable.** Anything prefixed
`EXPO_PUBLIC_` is embedded in the client bundle and visible to every user. AI provider keys,
database service keys, and other secrets will live only in backend environment configuration
introduced in later milestones. The one deliberate exception is the Supabase **anon** key, which
is public by design and safe only because row-level security is enforced on the server — see
ADR-0006.

## Backend (Supabase)

Authentication and the user profile use Supabase. Setup steps (create the project, apply
`supabase/migrations/`, configure `.env`) are in [`supabase/README.md`](supabase/README.md). The
app builds and runs without a configured backend; auth then reports a friendly
"service unavailable" state.

## Documentation

- Governing specification documents (authority order documented inside): `docs/product/`
- Architecture decisions: `docs/architecture-decisions/`
- Milestone worklogs: `docs/worklogs/`
