# Release Checklist

Ordered, actionable checklists from "code complete" (today) to public
launch. Each item is a real step; nothing is assumed done.

## Stage 1 — Founder infrastructure (before ANY real use)

- [ ] Create the DEVELOPMENT Supabase project; apply migrations 0001–0015 in order.
- [ ] Set `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` locally; sign up, create a course, confirm the shell works.
- [ ] Configure the worker: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`; upload a PDF and watch it reach READY.
- [ ] Add repo secrets `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` so CI's authz job (71 sections) activates — it must pass.
- [ ] Deploy edge functions (`health`, then billing ones when Stripe is set up); hit `health`.

## Stage 2 — Personal serious use (founder as student)

- [ ] Run the M15 section-B journey end to end (39 steps, recorded in `docs/worklogs/M15.md`) on the development project.
- [ ] Use the app for real study for at least a week; file anything broken as P1.
- [ ] Verify document delete/reprocess and account export on your own data.

## Stage 3 — Closed beta (5–20 users)

- [ ] Create the STAGING project; apply migrations; deploy functions; run authz there too.
- [ ] Stripe test mode: products/price, webhook endpoint, secrets; run the M14 24-step billing checklist.
- [ ] Decide beta billing posture (recommended: leave `subscriptions` flag FALSE — everyone effectively free; counters still record).
- [ ] Author seed content: target 100–300 reviewed questions across Med-Surg/Fundamentals/Pharm and ~10 cases (RN validation before canonical promotion).
- [ ] Wire error monitoring (`SENTRY_DSN`) or accept console-only for beta explicitly.
- [ ] TestFlight: Apple Developer account, `eas build --profile preview`, internal testers. (App config + eas.json are ready; accounts are not.)
- [ ] Real-device pass: iPhone + one Android — keyboard, upload, VoiceOver spot-check, notifications permission flow.
- [ ] Give beta users the support email and confirm "Report a problem" reports arrive in `question_feedback`.
- [ ] Rehearse a backup restore on staging.

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
