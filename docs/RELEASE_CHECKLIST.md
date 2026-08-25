# Release Checklist

Ordered, actionable checklists from "code complete" (today) to public
launch. Each item is a real step; nothing is assumed done.

## Stage 1 — Founder infrastructure (before ANY real use)

- [ ] Create the DEVELOPMENT Supabase project; apply migrations 0001–0015 in order.
- [ ] Set `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` locally; sign up, create a course, confirm the shell works.
- [ ] Configure the worker: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`; upload a PDF and watch it reach READY.
- [x] Add repo secrets `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` so CI's authz job (71 sections) activates — it must pass. Done 2026-08-25; two live bugs it surfaced are fixed (`0021`, `0022`, `scripts/authz-check.mjs`) — CI is green, `All authorization checks passed.`
- [x] Deploy edge functions (`health`, then billing ones when Stripe is set up); hit `health`. All 5 functions deployed 2026-08-25 (`content-review`, `health`, `create-checkout-session`, `create-billing-portal-session`, `stripe-webhook`); `health` hit live (`{"status":"ok","database":"ok",...}`). Deploying the billing functions' code is done ahead of schedule; they self-report "not configured" until Stripe secrets exist (Stage 3, see below) — see `docs/KNOWN_LIMITATIONS.md` for the exact remaining steps.

## Stage 2 — Personal serious use (founder as student)

- [x] Run the M15 section-B journey end to end (39 steps, recorded in `docs/worklogs/M15.md`) on the development project. Founder-reported 2026-08-25: using own account, "everything seem to work." Self-reported, not independently step-by-step verified — flag anything that breaks as you go.
- [~] Use the app for real study for at least a week; file anything broken as P1. In progress as of 2026-08-25 (founder using own account).
- [ ] Verify document delete/reprocess and account export on your own data.

## Stage 3 — Closed beta (5–20 users)

- [x] Create the STAGING project; apply migrations; deploy functions; run authz there too. **Deliberately skipped, decided 2026-08-25.** Founder chose to keep using the single existing project through closed beta rather than duplicate migrations/functions/CI secrets onto a second one — reasonable at 5–20 users. Revisit before Stage 4 (public launch), when testing against real paying users' data becomes the real risk a separate environment protects against.
- [ ] Stripe test mode: products/price, webhook endpoint, secrets; run the M14 24-step billing checklist. Billing edge function code is already deployed on the live project (2026-08-25) — this item is now just the Stripe-side account/product/secret work, all of which needs founder action (account creation and API-key/secret entry aren't things an assistant can do). Exact steps in `docs/KNOWN_LIMITATIONS.md`.
- [x] Decide beta billing posture (recommended: leave `subscriptions` flag FALSE — everyone effectively free; counters still record). Confirmed live 2026-08-25: `select enabled from feature_flags where key='subscriptions'` → `false`. Already matches the recommendation — no action needed unless you want to change it.
- [ ] Author seed content: target 100–300 reviewed questions across Med-Surg/Fundamentals/Pharm and ~10 cases (RN validation before canonical promotion). Editorial/clinical work — not something to generate unreviewed given this is nursing-education content patients' care decisions could trace back to.
- [x] Wire error monitoring (`SENTRY_DSN`) or accept console-only for beta explicitly. **Explicitly accepted console-only for beta, decided 2026-08-25** — no Sentry code exists yet (confirmed: zero references in the repo, it's genuinely nothing, not a stub). Revisit before Stage 4 when real users' crash reports start mattering.
- [ ] TestFlight: Apple Developer account, `eas build --profile preview`, internal testers. (App config + eas.json are ready; accounts are not.) Needs a $99/year Apple Developer account purchase — founder-only.
- [ ] Real-device pass: iPhone + one Android — keyboard, upload, VoiceOver spot-check, notifications permission flow. Needs physical devices — founder-only.
- [ ] Give beta users the support email and confirm "Report a problem" reports arrive in `question_feedback`. No support email exists anywhere in the app yet (checked 2026-08-25, zero matches) — needs a real inbox you'll monitor before this can be given out. The `question_feedback` delivery mechanism itself is already M15 code-verified.
- [ ] Rehearse a backup restore on staging. **Blocked on something bigger than "no staging":** checked 2026-08-25, the project's Free Plan has **no backups at all** (Database → Backups: "Free Plan does not include project backups" — Pro plan adds up to 7 days of scheduled backups). Right now, if this database were lost, everything in it — your own weeks of study data, and soon beta users' — is unrecoverable. Worth deciding on its own, independent of the staging question, before opening this up to other people.

## Stage 4 — Public commercial launch

- [ ] Create the PRODUCTION Supabase project on a backed-up plan; apply migrations staging-first.
- [ ] Legal: professional review of Terms/Privacy; replace in-app placeholders.
- [ ] Pricing: founder-approved free limits + PRO price; update `PLAN_DEFINITIONS` + SQL mirror together (one rules version bump).
- [ ] Stripe live mode: live keys/webhook; one real end-to-end purchase + cancel.
- [ ] Implement password reset.
- [ ] Native store billing if launching paid on mobile: Apple/Google products + RevenueCat adapter (steps in M14 worklog) — or launch web-billing-only deliberately.
- [ ] App Store / Play submissions (assets, privacy questionnaires, review).
- [ ] Production web host with SPA rewrites; point `BILLING_RETURN_URL` at it.
- [ ] Flip `subscriptions` to TRUE when ready to enforce.
- [ ] Confirm monitoring, analytics key, and backups are production-grade.

## Every release, always

- [ ] CI green on main (includes tests, authz, audit, secret scan).
- [ ] New migrations applied dev → staging → production, forward-only.
- [ ] `docs/worklogs/` entry for anything milestone-sized.
- [ ] No force-push; no manual production schema edits.

Tagging policy: none defined yet. If releases need tags, adopt
`v<major>.<minor>.<patch>` and document it here first (M15 spec BB —
do not invent tagging silently).
