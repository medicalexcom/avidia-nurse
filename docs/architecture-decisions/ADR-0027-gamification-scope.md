# ADR-0027: Gamification scope — derived streaks only, no XP economy

- **Status:** Accepted
- **Date:** 2026-08-13
- **Milestone:** M10

## Context

The M10 instruction permits XP, levels, achievements, and streaks "if
approved by the product documents", with hard requirements: gamification
must serve learning, XP (if built) must be server-authoritative, and
nothing may pressure guessing, punish slower learners, or reward volume
over understanding.

## Decision

### 1. Streaks are the only gamification, because that is all the documents approve

A careful search of the authoritative documents (Playbook v2, Blueprint v2,
ABSN Study System) finds exactly one motivational mechanic: streaks ("Add
Boss Battle, dashboards, streaks, and mastery heatmaps only after the
learning engine works well"). XP, levels, points, badges, and achievements
appear nowhere. Under the spec's own filter — nothing beyond what the
product documents support — M10 therefore ships streaks and deliberately
does NOT build an XP economy, levels, or achievements. This also dissolves,
rather than solves, the entire server-authority/anti-forgery problem an XP
ledger would create.

### 2. A streak is a pure derivation, not stored state

`computeStudyStreak` derives the streak from the timestamps of the
student's own `question_attempts` rows — server-written, immutable,
RLS-scoped. There is no counter to store, drift, or forge (spec X by
construction), no new table or column (spec AL), and the number is
recomputable at any time. Timezone correctness reuses the domain's
`calendarDateInZone` utility — the same calendar-day logic as exam
countdowns.

### 3. Non-punitive by design

A run ending yesterday still counts before the student studies today, so a
morning open never shows a "broken" streak for an unfinished day. The copy
is quiet and factual ("Study streak: 3 days — today counts."), never a
threat about losing anything, and a zero streak shows nothing at all.
Studying ANY amount preserves it — a streak measures showing up, not
volume, so it cannot reward binge-answering or punish a short day.

## Alternatives considered

- **Server-authoritative XP ledger (append-only events).** Technically
  sound, but rejected: no product document asks for XP, and unapproved
  reward mechanics risk optimizing for points over learning — the exact
  failure mode the milestone's core principle warns about.
- **Client-computed streak stored in a profile column.** Rejected: stored
  derived state can drift and be forged; the pure derivation cannot.

## Consequences

- Zero new persistence, zero new attack surface; existing authz checks
  already cover everything the streak reads.
- If a future milestone (M12 analytics or later) legitimizes richer
  mechanics via updated product documents, the append-only-events design
  sketched in the M10 spec remains the right starting point.
