# ADR-0035: Local notifications only, opt-in, engine-authored

- **Status:** Accepted
- **Date:** 2026-08-14
- **Milestone:** M13

## Context

M13 asks for study, review, and exam reminders (spec AA–AI) and requires
choosing between local notifications, remote push, or both — preferring
the simplest architecture that satisfies the product (spec AH). Every
reminder M13 needs is derivable from data already on the device: the
student's own plan, their exams, their preferences, and their timezone.
Remote push would add a token registry, a server scheduler, a delivery
provider, and a new privacy surface (spec AP) — for no capability the
product actually requires.

## Decision

### 1. Local notifications only — no push infrastructure

Reminders are scheduled on-device with `expo-notifications` from the
student's own active plan. There are no device tokens, no server fan-out,
no third-party delivery of learning data. If a future milestone needs
server-initiated messaging (e.g., collaborative features), push can be
added then; nothing in M13's model blocks it.

### 2. The pure engine authors every reminder

`buildReminderInstructions` in `@avidia/planner` decides what to say and
when: it honors the per-type opt-in preferences, computes fire times in
the student's timezone at the configured reminder hour, defers anything
inside quiet hours to when the window ends (spec AD), and caps volume
(one study reminder per planned day, one per due-review day, one per
approaching exam — spec AA). Bodies carry only plan existence, minutes,
and exam countdowns — never performance details (spec AF/AP) — and unit
tests assert this. The app-side adapter (`notifications.ts`) only
schedules the instructions it is handed.

### 3. Idempotent by construction

Syncing cancels all scheduled notifications and reschedules from the
current plan, keyed by stable instruction IDs. Replanning, exam changes,
and missed days therefore never stack duplicates, and superseded work
cannot fire stale reminders (spec AY). Turning every toggle off clears
the queue.

### 4. Contextual, conservative permission (opt-in defaults)

All reminder toggles default OFF (spec AE). Permission is requested only
from the settings screen, in direct response to the student enabling a
toggle (spec AB). Denial keeps the toggle off with a plain explanation;
`canAskAgain === false` is respected permanently — the app never nags.

### 5. Web degrades gracefully; deep links are allowlisted

`expo-notifications` is imported lazily, so the web bundle and jest never
touch the native module. On web, `remindersSupported()` is false and the
settings screen states that reminders are app-only while the planner
works fully (spec AI). Notification taps navigate through
`safeDeepLink`, which maps anything outside a small in-app allowlist
(`/planner`, `/home`, `/study`) to `/home` (spec AG); authorization is
still enforced by the auth gate and RLS on arrival.

## Consequences

- Zero new backend infrastructure, zero learning data leaving the device
  via notifications, minimal permission surface.
- Reminders fire only while scheduled locally; they cannot be delivered
  to a logged-out or uninstalled app — acceptable for study nudges.
- Scheduling depends on the app having built a plan recently; syncing on
  plan generation keeps the queue fresh without background tasks.
- Volume caps and quiet hours are engine-tested, so notification
  behavior is verified without native test harnesses.
