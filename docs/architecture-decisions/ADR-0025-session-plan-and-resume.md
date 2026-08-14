# ADR-0025: Stored session plan, resume, and in-session adaptation

- **Status:** Accepted
- **Date:** 2026-08-13
- **Milestone:** M9

## Context

M9 turns the M8 recommendation engine into a daily habit: a student picks a
duration (5/10/20/45 minutes), gets a planned adaptive session, and must be
able to close the app mid-session and continue later with no duplicate
mastery updates (spec O). The session must also adapt mid-flight to fresh
answers (spec J) without the client ever recomputing mastery (spec C) and
without duplicating M8's prioritization logic in UI code. Three tensions had
to be resolved: persistence vs. adaptivity (a stored plan is static; an
adaptive order is not), server truth vs. client responsiveness, and failure
tolerance (spec W: losing the plan write must not lose the session).

## Decision

### 1. The stored plan is the resume baseline, not the live order

A new `study_session_plan` table (migration 0009) records, at session start,
the ordered question ids chosen by the pure `@avidia/mastery` selection —
`(session_id, position, question_id, skipped_at)`. It is written once, in
bulk, immediately after the session row is created. On resume, the client
replays: plan rows minus answered questions (from `question_attempts`, the
single source of attempt truth — spec Y) minus skipped rows minus questions
that have since been retired. Answered work is never re-asked and mastery is
never re-submitted, because resume is derived from the attempt records the
server already owns.

### 2. In-session adaptation is an in-memory re-rank of the remainder

After each answer, the client re-ranks only the _remaining_ planned
questions using `rankConcepts` over fresh mastery — fed by the server's own
`v_mastery_json` echo returned from `submit_question_attempt` (the client
applies the returned aggregate verbatim; it performs no mastery arithmetic,
spec C). The reorder uses the deterministic seed `${sessionId}:${answeredCount}`
so the same state always yields the same order. The stored plan is NOT
rewritten: the set of questions in a session is fixed at start; adaptation
changes sequence, not content. This keeps resume deterministic (the baseline
plan is immutable) while the live session still responds to performance
(spec J), and it means an exact just-answered question cannot repeat (spec K)
because answered ids are subtracted before re-ranking.

### 3. Skips are explicit state, and the only client-updatable column

`skipped_at` is the single column clients may update (grant + RLS policy,
in-progress sessions only). A skip is never recorded as correct or incorrect
(spec AB) and never touches mastery; it simply excludes the row from resume.
Plan `position` and membership are immutable to clients, so the resume
baseline cannot be forged or rewritten after the fact.

### 4. Plan persistence is best-effort; the session is not (spec W)

`insertSessionPlan` failure is caught and swallowed: the student still
studies the full in-memory session — only resume-after-restart is lost for
that one session. Similarly `markPlanSkipped` and `findResumableSession` are
best-effort. The only hard dependencies of a running session are the session
row and the attempt RPC, both of which predate M9.

## Alternatives considered

- **Rewrite the stored plan after every answer.** Rejected: turns every
  answer into an extra write, creates races between devices, and makes the
  stored plan a cache of derived state — the exact duplicate-state smell
  spec Y forbids. The baseline-plus-derivation model stores only facts.
- **Server-side session orchestration (RPC returns "next question").**
  Rejected for v1: it adds a round-trip per question, moves pure ranking
  logic behind the database boundary where it is harder to test, and the
  client already holds everything needed (the pure engine + server mastery
  echoes). Nothing prevents promoting orchestration server-side later; the
  plan table and attempt records are already the authoritative inputs.
- **No stored plan (rebuild the session from ranking on resume).** Rejected:
  re-ranking after a restart could silently produce a different session than
  the one the student started (mastery changed mid-session), breaking the
  "continue where you left off" promise and making session summaries
  incoherent.

## Consequences

- Resume works across app restarts with zero duplicate mastery updates; a
  fully-answered plan auto-closes as completed on resume.
- Summaries after a resume can only attribute mastery deltas to answers made
  since the resume (pre-restart deltas are not re-fetched in v1) — an honest
  limitation noted in the M9 worklog.
- The plan cap (50 rows, DB check) bounds the write and matches the pure
  module's `MAX_SESSION_QUESTIONS`.
- Authz checks 45–48 pin the security model: owner-scoped end to end,
  `skipped_at`-only updates, no writes to closed sessions, cascade on
  session deletion.
