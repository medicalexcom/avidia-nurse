# Known Limitations (post-M15 audit, 2026-08-16)

Honest inventory of what Avidia Nurse v1 does NOT do, with severity.
Nothing here is hidden behind marketing language. P-levels follow the
M15 QA scale (P0 critical … P3 polish). The items below include required
founder-use capabilities that are absent; the earlier M15 conclusion did not
cover the later dynamic-generation requirements.

## Requires live verification before real use

- Supabase/OpenAI configuration may exist in the deployment environment, but
  repository source cannot prove secret values, migration state, or provider
  access. Apply migrations through `0022`, run the authz harness and model
  verification workflow, then complete the founder journey.
- **CI's authz (RLS/IDOR) harness now runs live** (2026-08-25) — repo
  secrets `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` are
  set, so `pnpm run test:authz` no longer SKIPs in CI. Its first live run
  found two real database gaps, both fixed here: migration `0018`'s column
  grants for `ai_learning_requests`/`tutor_conversations`/`tutor_messages`
  were applied to the live database without the INSERT/UPDATE column grants
  it specifies (`0021` reapplies exactly those grants), and
  `delete_my_account()` deleted `storage.objects` rows directly in SQL,
  which Supabase's storage engine no longer permits — `0022` removes that
  statement; storage cleanup moves to the client (`billingApi.ts`'s
  `deleteMyAccount`), which lists the caller's storage keys, calls the RPC,
  and only removes those objects once it succeeds (never on the
  guarded/blocked path). If that client-side cleanup step never runs (app
  closed mid-flow, network failure), the objects are orphaned under the
  deleted owner's private storage path — unreachable by any other user, so
  this is a storage-cost cleanup gap, not a privacy or correctness issue.
  A third failure (the three "owner creates a tutor conversation" /
  "owner writes own user tutor message" / "owner queues personalized
  learning" checks) persisted after `0021`/`0022` were applied and
  verified live; it turned out to be a bug in the harness script itself,
  not the database — those three checks reused `courseId`, a course that
  an earlier section (`18`, cascade-delete coverage) had already deleted,
  so their owner/course `with_check` clause could never pass. Fixed in
  `scripts/authz-check.mjs` by giving that section its own course.
- **Password reset redirect URLs are now allow-listed** (2026-08-25).
  Supabase rejects `resetPasswordForEmail`'s `redirectTo` unless it's on
  the project's allow-list (Authentication → URL Configuration → Redirect
  URLs); all three documented URLs are now added there:
  `https://medicalexcom.github.io/avidia-nurse/reset-password`
  (production), `http://localhost:8081/reset-password` (local dev), and
  `avidianurse:///reset-password` (native, ready ahead of distribution).
- **All 5 edge functions are now deployed** (2026-08-25): `content-review`,
  `health`, `create-checkout-session`, `create-billing-portal-session`,
  `stripe-webhook`. `health` verified with a direct call:
  `{"status":"ok","database":"ok",...}`. Each function's "Verify JWT"
  gateway setting was checked against its own design.
  `create-checkout-session` and `create-billing-portal-session` correctly
  need it ON (the app always sends a real user JWT) and were left as
  deployed. `health` and `stripe-webhook` both need it OFF — `health`
  must answer even when auth itself is broken, and Stripe cannot send a
  Supabase JWT (`stripe-webhook`'s own code comment says so) — both
  defaulted to ON on deploy and were corrected. `stripe-webhook` was
  re-verified live afterward: `POST` with no signature →
  `500 {"error":"not configured"}`, i.e. it was reached and evaluated,
  not blocked at the gateway.
  **Deploying the billing functions' code does not activate billing.**
  They all correctly self-report "not configured" (503/500) because no
  Stripe secrets exist yet. To actually activate Stripe test-mode
  billing, Stage 3 needs, all from the founder (account creation, product
  setup, and API-key/secret entry cannot be done by an assistant):
  1. A Stripe account, in test mode, with a recurring PRO price created.
  2. Edge function secrets set in Supabase (Project Settings → Edge
     Functions → Secrets, or `supabase secrets set`):
     `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_PRO`, `BILLING_RETURN_URL`
     (for `create-checkout-session` / `create-billing-portal-session`),
     and `STRIPE_WEBHOOK_SECRET` (for `stripe-webhook`, once the webhook
     endpoint below exists — Stripe generates this secret per endpoint).
  3. A Stripe test-mode webhook endpoint pointed at
     `https://ydfbmzgeavkwvnslawny.supabase.co/functions/v1/stripe-webhook`,
     subscribed to `checkout.session.completed`,
     `customer.subscription.created/updated/deleted`, and
     `invoice.payment_failed`.
  4. The `subscriptions` feature flag flipped true (currently FALSE —
     see `docs/worklogs/M14.md` for the flag mechanics).
     Once those exist, the M14 24-step billing checklist
     (`docs/worklogs/M14.md`) is what to run through.
- **Seed content not authored** — playbook target of 100–300 RN-reviewed
  questions and ~10 clinical cases for beta is editorial work, not code.
  One synthetic simulation case ships (migration 0012).
- **Content review tool: already live, already usable (found + wired up
  2026-08-25).** The `content-review` edge function and its screen
  (`app/(app)/review.tsx`) were already deployed and complete before this
  finding — CORS and the reviewer-auth gateway were live-verified directly
  (`OPTIONS` preflight succeeds, unauthenticated `POST` correctly rejects at
  the gateway). The founder's own account already has `role = 'reviewer'` —
  nothing to grant. **Profile → "Open review queue"** works today.
  What _wasn't_ true until today: the generation pipeline never actually
  produced the `generated` status this tool is built to review — every
  clean-passing AI question went straight to `active` (live to students,
  unreviewed by anyone) the moment the automated validator approved it;
  only the minority the validator itself flagged ever reached the queue.
  Migration `0023` (staged, not yet applied — see below) plus a matching
  code change to `packages/assessment/src/validate.ts` fix this: every
  newly generated question now lands `generated` or `flagged`, never
  `active`, and only a reviewer's approval through the tool sets it live.
  **Action needed:** run `supabase/migrations/0023_generated_status_review_gate.sql`
  in the SQL editor (three `CREATE OR REPLACE FUNCTION` statements — widens
  the status allow-list on both generation RPCs and the two orphan-retirement
  sweeps; no data is touched, nothing here can be run automatically per this
  session's standing rule against executing schema changes directly).
  The 116 questions already `active` in the live database were _not_
  reviewed by anyone — they only passed the automated pipeline. This
  migration doesn't touch them retroactively; whether to pull any of them
  back for review is a separate decision, not something changed here.

## Current limitations

- Personalized generation and Ask Avidia require a continuously running worker for responsive use; the 15-minute scheduled GitHub workflow is only a fallback.
- Live provider/model access and the new RLS policies require founder-environment acceptance testing.
- Current question-bank background generation remains ECONOMY; its defined complex-question route is not yet selected automatically.
- Generated case-study questions currently provide unscored in-case feedback;
  they do not yet create M7 attempts or M8 mastery evidence. Scored “Quiz me”
  requests deliberately hand off to the existing adaptive practice flow.

## Product limitations (accepted for v1 beta)

- **Store billing is an honest stub** (documented) — native purchase
  buttons say purchases aren't available in this build. Web Stripe
  billing is complete. Activation steps: `docs/worklogs/M14.md`.
- **No offline mode** (P2). Only auth sessions and a 72-hour entitlement
  cache persist locally; every screen needs the network and shows a
  friendly error with retry when it's absent. This is honest, not
  claimed otherwise.
- **Local notifications only** — reminders schedule when the app builds
  or refreshes a plan; there is no push infrastructure (ADR-0035).
- **Light mode only** (P3). `userInterfaceStyle` is `light`; no dark
  theme.
- **No reduced-motion handling** (P3) — the app uses essentially no
  animation, so exposure is minimal, but the preference isn't read.
- **Single root error boundary** (P3) — a render crash recovers at the
  app level, not per screen.
- **Week view is a list, not a calendar grid**; no external calendar
  sync (M13 scope).
- **Error monitoring not wired** (P2) — `SENTRY_DSN` is the documented
  hook; until wired, production render errors are only visible in
  structured console logs.
- **Free-plan limits and PRO pricing are engineering placeholders**
  pending founder pricing decisions.

## Legal / compliance

- Privacy Policy and Terms are in-app placeholders explicitly marked
  "pending legal review". **Professional legal review is required before
  public commercial launch.** No approval is claimed.
- Backup/retention promises are deliberately absent until production is
  on a backed-up plan with a rehearsed restore.

## Not testable in the current build environment

Recorded as NOT TESTABLE, not as passes: real-device iPhone/Android
behavior (Dynamic Type, VoiceOver/TalkBack, keyboard, file picker),
TestFlight/Play builds (EAS config now exists; accounts don't), live
Stripe round-trips, live database drift comparison, real-scale
performance measurements. Static/code-level review of each was done in
M15; see `docs/worklogs/M15.md` for the honest per-step record.

## Deferred to the post-v1 roadmap (deliberately out of scope)

Faculty/instructor tools, cohort/social features, push notifications,
external calendar sync, grade prediction (deliberately excluded), full
offline study, additional plan tiers, SSO, in-app support platform.
