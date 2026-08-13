# Avidia Nurse

Avidia Nurse is a commercial adaptive nursing-education platform for ABSN/BSN students. One
cross-platform student application (iOS, Android, and web/desktop) delivers course-material-grounded
study tools, persistent mastery tracking, spaced repetition, and stateful patient simulations —
powered by AI but never dependent on any single AI provider.

**Current milestone: M4 — Document Extraction and Processing.** Uploaded materials (PDF, PPTX,
DOCX, TXT) are now processed by a background worker into ordered, provenance-preserving
`document_sections` (page numbers, slide numbers, headings, bullet hierarchy, tables, speaker
notes) using deterministic parsers — no AI calls, no OCR (image-only PDFs are flagged, not
faked). Documents move through `uploaded → queued → processing → ready | failed` with
database-enforced transitions, idempotent reprocessing, and student-safe error messages.
Semantic concepts, embeddings and retrieval (RAG) begin in M5; AI study tools and analytics
arrive in later milestones and are clearly marked as placeholders in the app.

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
│   │       ├── features/   # auth, profile, courses, materials (upload/storage/screens)
│   │       └── ui/         # Theme, shared components, responsive navigation shell
│   └── worker/             # Background document-processing worker (service role, Node/tsx):
│                           # claims queued documents, extracts, stores sections, sets status
├── packages/
│   ├── config/             # Platform-agnostic shared configuration (no React, no LLM deps)
│   ├── domain/             # Pure domain logic: validation, timezone-safe time math, exam
│   │                       # countdowns, section/provenance model and state machine
│   └── ingestion/          # Deterministic PDF/PPTX/DOCX/TXT extraction (no AI, no network)
│                           # plus in-memory test-fixture builders
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
