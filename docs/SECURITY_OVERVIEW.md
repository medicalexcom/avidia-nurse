# Security Overview

How Avidia Nurse protects student data, as actually implemented through
M14 and audited in M15. This is a description of the shipped system, not
an aspiration.

## Authentication and sessions

Supabase email/password auth. The client holds only the anon key; every
data request carries the student's JWT. Route protection is a pure,
unit-tested `decideRoute(status, routeGroup)` gate in the root layout:
signed-out (or backend-unavailable) users are redirected to sign-in
before any `(app)` route renders; sessions restore from AsyncStorage
(native) / localStorage (web) with a loading state that prevents
flash-of-protected-content. Password reset is NOT implemented yet
(documented limitation).

## Authorization: RLS everywhere, server-authoritative writes

Every user-data table across migrations 0001–0015 has row-level security
enabled and forced. The pattern is consistent: students can SELECT their
own rows; anything derived or scored (sections, chunks, concepts,
question scoring, mastery, plan revisions, subscriptions, usage) is
written only by SECURITY DEFINER RPCs or the service-role worker, with
`revoke all ... from public, anon` and explicit grants. Intentional
broader reads, both documented: `simulation_cases` (active curriculum)
and `feature_flags` (client needs the enforcement switch).

Two deliberate redaction boundaries: simulation hidden state never
reaches the client, and question correct answers are never shipped
before scoring (`submit_question_attempt` scores server-side).

The automated harness `scripts/authz-check.mjs` runs 71 sections of
live cross-user/IDOR/forgery checks (two students + anon + admin),
covering every domain from profiles through subscriptions. It requires a
live Supabase project; CI runs it when the repo secrets exist.

## Payments

Payments are never client-authoritative. The Stripe webhook (HMAC
SHA-256 signature verified, constant-time compare, 300s tolerance,
idempotent by provider event id) is the only writer of subscription
rows. Clients cannot insert/update/delete subscriptions at all. Card
data never touches Avidia — Stripe-hosted Checkout and Billing Portal
only. Native store billing is an honest not-configured stub; a store
purchase would never grant access locally.

## Secrets

- Client bundle: only `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`,
  `EXPO_PUBLIC_APP_ENV` (+ optional analytics key). All safe-by-design.
- Service-role key: worker and test harness only; `apps/app` has zero
  references (verified by audit and enforced by comment/convention in
  `src/lib/supabase.ts`).
- Stripe secrets: Supabase edge-function secrets only.
- CI: gitleaks secret scan over full history on every push/PR;
  M15 audit found no credentials in the working tree or git history.
- If a real credential is ever committed: treat it as compromised and
  rotate it at the provider — deleting the file is not sufficient.

## Dependencies

CI fails on HIGH/CRITICAL advisories (`pnpm audit --audit-level high`).
Current ignores (3, with rationale in `docs/worklogs/M14.md`): two
`image-size` advisories with no upstream fix (build-time only) and one
`pdfjs-dist` advisory whose documented mitigation (`isEvalSupported:
false`) is applied in `packages/ingestion`.

## Privacy posture

- Analytics events are payload-free names (verified by test).
- Edge functions and the worker log structured JSON without PII or
  document content; the app error boundary logs error name/message/
  component stack only.
- Students can export all their data (`export_my_data`) and delete
  their account (`delete_my_account`, guarded so deletion never leaves
  a still-charging subscription).
- PHI: students are instructed not to upload patient data; the platform
  is educational and not clinical decision support (in-app disclaimer).

## Known gaps (tracked in KNOWN_LIMITATIONS.md)

Password reset; no SAST tool beyond ESLint/typechecking; error
monitoring hook (`SENTRY_DSN`) documented but not wired; authz harness
requires a live project to execute.
