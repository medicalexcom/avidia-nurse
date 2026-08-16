# Known Limitations (post-M15 audit, 2026-08-16)

Honest inventory of what Avidia Nurse v1 does NOT do, with severity.
Nothing here is hidden behind marketing language. P-levels follow the
M15 QA scale (P0 critical … P3 polish). The items below include required
founder-use capabilities that are absent; the earlier M15 conclusion did not
cover the later dynamic-generation requirements.

## Requires founder action before any real use

- **No Supabase project exists yet** — every server-dependent feature is
  unverified against live infrastructure until the founder provisions
  development/staging (see `docs/ENVIRONMENTS.md`). The 71-section authz
  harness and the manual journeys (M14/M15 checklists) run then.
- **No AI provider keys configured** — document processing and question
  generation need `OPENAI_API_KEY` on the worker.
- **Seed content not authored** — playbook target of 100–300 RN-reviewed
  questions and ~10 clinical cases for beta is editorial work, not code.
  One synthetic simulation case ships (migration 0012).

## Current limitations

- Personalized generation and Ask Avidia require a continuously running worker for responsive use; the 15-minute scheduled GitHub workflow is only a fallback.
- Live provider/model access and the new RLS policies require founder-environment acceptance testing.
- Current question-bank background generation remains ECONOMY; its defined complex-question route is not yet selected automatically.

## Product limitations (accepted for v1 beta)

- **No password reset** (P2). A student who forgets their password needs
  founder help via the Supabase dashboard. Add `resetPasswordForEmail`
  before public launch.
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
