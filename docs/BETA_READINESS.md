# Beta Readiness

> **2026-08-16 finalization:** dynamic case studies, validated simulation authoring, and Ask Avidia are now code-complete behind migration 0018 and the server worker. Live founder acceptance remains required with Supabase/OpenAI credentials.

Verdict, evidence, and conditions for the Avidia Nurse v1 closed beta.
Assessed 2026-08-14 at the M15 commit. Companion documents:
`KNOWN_LIMITATIONS.md`, `RELEASE_CHECKLIST.md`, `worklogs/M15.md` (full
acceptance matrix and journey record).

## Verdict

**READY WITH NON-BLOCKING LIMITATIONS — conditional on founder
infrastructure setup.**

The codebase is complete, validated (867 automated tests, CI fully
green, zero open P0/P1 defects), and hardened. What stands between
today and a real beta is not code: it is provisioning (Supabase
projects, AI keys, Apple/Stripe accounts), seed content authoring, and
one live end-to-end verification pass on real infrastructure. Those are
Stage 1–3 of `RELEASE_CHECKLIST.md`.

## What is proven by automated evidence

- All 13 packages pass: entitlements 25, planner 46, analytics 65,
  simulation 107, mastery 90, assessment 49, knowledge 65, rag 48,
  domain 81, ingestion 10, worker 41, config 10, app 230 — 867 total.
- Golden regression suites cover mastery scenarios, planner cases A–H,
  analytics synthetic students, simulation optimal/delayed/unsafe paths,
  question quality fixtures, DST/timezone handling, billing cases.
- Security: gitleaks (full history) and dependency audit green; no
  service-role reference in the client; no secrets in tree or history.
- The web production build exports cleanly.

## What is verified only by code review (needs live confirmation)

RLS/IDOR behavior (harness written — 71 sections — but requires a live
project), the full section-B student journey, Stripe round-trips,
document processing against real AI providers, performance at realistic
scale, real-device mobile behavior.

## Beta safety gates (spec AP)

- Billing enforcement: behind the `subscriptions` flag, ships OFF —
  recommended posture for beta (learning features free, usage recorded).
- Native store purchases: honest not-configured stub — cannot mislead.
- High-risk content: question generation is provenance-grounded,
  flagged/rejected items never enter study, students can report any
  question ("Report a problem" → `question_feedback`), and the
  educational disclaimer is in-app. AI never invents unsourced clinical
  claims in canonical content; RN validation is required before
  canonical promotion of seed items.
- No feature known to be unreliable ships enabled; nothing needed
  disabling beyond the flags above.

## Conditions before inviting the first outside user

1. Development + staging Supabase projects live, migrations applied,
   authz harness passing (this converts the code-reviewed security
   posture into verified fact).
2. One founder-run pass of the 39-step journey on real infrastructure.
3. Worker running with AI keys; a real course document processed READY.
4. Support email decided and shared with testers.
5. Seed content at least minimally present so a tester sees value
   without uploading private material.

## What beta should measure (playbook §24)

Activation (account → course → upload → first completed session), D1/D7
retention, sessions per active week, questions/simulations completed,
AI schema-failure rate and cost per active user, document-processing
latency/failure — all supported by existing structured data and
payload-free events.
