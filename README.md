# Avidia Nurse

Avidia Nurse is a commercial adaptive nursing-education platform for ABSN/BSN students. One
cross-platform student application (iOS, Android, and web/desktop) delivers course-material-grounded
study tools, persistent mastery tracking, spaced repetition, and stateful patient simulations —
powered by AI but never dependent on any single AI provider.

**Current milestone: M13 — Intelligent Study Planner, Calendar, Exam Countdown, and
Notifications.** Avidia now answers "what should I study between now and my exam?" with a
deterministic planner (`@avidia/planner`) that IS NOT ANOTHER MASTERY ENGINE — it consumes M8
priorities/due reviews, M12 coverage and cognitive-level signals, M10 mode eligibility, and M11
case availability to place work into the student's real availability (Light/Standard/Intensive
presets or per-weekday custom minutes). Plans are exam-aware across multiple exams and courses
(every recommendation stays course-scoped), reserve time for due reviews, schedule coverage
blocks for unassessed content (unassessed ≠ weak), slot misconception remediation with
diversity caps, and pick higher-order or simulation practice only when evidence and time
support it. Capacity is honest: overflow is stated, then triaged (misconceptions → exam
priorities → due reviews → coverage → higher-order → enrichment) — never silently compressed.
Every planned item carries deterministic reason codes; recalculation regenerates from current
evidence so missed days re-triage instead of stacking and extra study is absorbed. Plans
persist server-side as revisions behind SECURITY DEFINER RPCs with evidence-based completion
(a real completed session, idempotent, one session satisfies one activity) and RLS throughout.
The Today view leads with exam countdowns in the student's timezone and START TODAY'S PLAN,
which launches the existing M9/M10/M11 experiences; a simple week list shows what's ahead.
Reminders are local-only (no push infrastructure), all opt-in and off by default, permission
asked contextually in settings, quiet-hours aware, privacy-conscious in content, with
allowlist-validated deep links — and the web app works fully without them. The whole layer is
deterministic, LLM-free, and covered by golden scenario tests (exam-in-7-days through no-exam),
DST/timezone tests, reminder tests, and RLS/idempotency checks.

Previous milestone — M12, Learning Analytics, Readiness, and Performance Intelligence: the
Progress and Weaknesses tabs are now live: every course gets an actionable analytics page built
on a new pure read model (`@avidia/analytics`) that CONSUMES the M8 mastery engine rather than
duplicating it — mastery states, review schedules, and study priorities are computed by the one
existing engine, and analytics only interprets its outputs. The page answers "how am I doing and
what should I do next": a mastery map over the five M8 states, evidence-backed needs-attention
and strengths lists (unassessed is never called weak, and every flag carries its reason),
deterministic week-over-week trends that refuse to judge tiny samples, cognitive-level and
difficulty breakdowns, supportive confidence calibration, exam readiness as an honest state
(Early days / Building / On track / Strong position) with WHY reasons, a coverage-versus-mastery
distinction, and NEVER a grade prediction, plus study consistency from attempt timestamps,
mode/medication/simulation aggregates (via one compact read-only RPC that keeps hidden case
internals server-side), clinical judgment shown side-by-side without a blended score, and up to
three deterministic insights whose CTAs route into the existing engines. All minimum-evidence
thresholds live in one documented module; the whole layer is deterministic, LLM-free, bounded
in what it fetches, and covered by golden synthetic-student tests, DST-crossing timezone tests,
and data-integrity tests.

Previous milestone — M11, Stateful Patient Simulation and the Virtual Clinical Engine: the
blueprint's virtual patient arrived as a deterministic, server-authoritative engine — THE LLM IS
NOT THE SIMULATION ENGINE. Patient state, action validity, transitions, critical events,
scoring, and outcomes are structured case data interpreted by versioned, replayable code
(`packages/simulation`), with sessions pinned to the exact definition snapshot they started
under, redacted client views (hidden findings and rules never leave the server), idempotent
action submission, NCSBN-CJMM-aligned deterministic scoring, a full post-completion debrief, and
simulation evidence flowing into the ONE existing M8 mastery model — never a parallel one.

Previous milestone — M10, Advanced Study Modes, Clinical Drills, and Learning-Centered
Gamification: Five study modes sit beside daily study, all built from the SAME validated
question bank and scored by the SAME server pipeline that feeds the single mastery model:
Rapid Response (foundational recall — speed never changes mastery), Find the Danger (spotting
the highest-risk cue), Who First? (defensible prioritization drills), Medication Lab
(course-grounded pharmacology and tolerance-checked calculations), and Boss Battle (a
cumulative challenge in Foundation → Application → Prioritization → Integrated rounds). Modes
are pure registry entries — deterministic filters plus seeded orderings over stored question
facts — with explicit eligibility and guiding locked states ("Medication Lab unlocks when your
course materials cover medications"), and the only schema change is five new honest
`session_type` labels. Gamification is exactly what the product documents approve: a streak,
derived purely from the student's own attempt timestamps (timezone-correct, zero stored state,
non-punitive — a run ending yesterday still counts before today's study). No XP, levels, or
badges — the documents don't ask for them, and unapproved reward mechanics risk optimizing for
points over learning.

Previous milestone — M9, the Daily Adaptive Study Experience: The app now opens on a Today
screen whose central action is START TODAY: the student picks how much time they have
(5/10/20/45 minutes) and gets a planned adaptive session built from the M8 recommendations over
the persisted, validated question bank — one question at a time, optional one-tap confidence,
concise rationales with "Explain more", "View source" back to the original document and
slide/page (never chunk ids), and a deterministic "why am I studying this" from the M8 reason
codes (never AI text). Sessions adapt mid-flight using the server's own mastery echo (the UI
performs no mastery math), never immediately repeat a just-answered question, treat skips as
explicit tracked state that is never scored, survive app restarts via a stored session plan
with no duplicate mastery updates, and end with an honest summary — counts and concept names,
no fake precision. Due reviews consume M8's stored schedule (no second scheduler), exam
pressure flows through the M8 urgency factor (exam mode is not a separate mode), quick
sessions use the same pipeline, and misconception moments use respectful copy.
Privacy-conscious analytics events carry names, durations, and counts only. There is no AI
chat box on home, no gamification, and no notifications; streaks are deferred to M10 and deep
analytics to M12.

Previous milestone — M8, the Adaptive Mastery Engine and Intelligent Study Scheduler: every
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
│   │       ├── features/   # auth, profile, courses, materials, concepts, practice, study, today, modes
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
