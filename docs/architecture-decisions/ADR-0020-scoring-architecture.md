# ADR-0020: Scoring architecture — server-side, deterministic, immutable

- **Status:** Accepted
- **Date:** 2026-08-13
- **Milestone:** M7

## Context

If correctness is computed on the client, the client must possess the
answer key — which contradicts the no-leakage schema (ADR-0018) and lets a
tampered client forge results that M8 analysis would later trust. Scoring
therefore has to happen where the answers live, atomically with recording
the attempt (spec V/W/AB).

## Decision

### 1. One write path: `submit_question_attempt` (spec V/AB)

`question_attempts` has **no insert/update/delete grants or policies** for
clients. The only way an attempt exists is the SECURITY DEFINER RPC, which:

1. verifies the caller owns the session's course (guessed session ids fail
   identically to nonexistent ones),
2. verifies the session is `in_progress` and the question is an `active`
   question of the **same course**,
3. validates the response shape and that every referenced option belongs to
   this question,
4. scores deterministically per type,
5. inserts the attempt row, and only then
6. returns `is_correct`, the teaching rationale, per-option truths and the
   numeric expectation — the first and only moment the client sees them.

### 2. Deterministic scoring rules (spec P)

- **Choice** (`single_best_answer`, `multiple_response`): set equality of
  selected vs. correct option ids — order never matters, partial credit
  does not exist in M7.
- **Ordered**: exact sequence equality against `correct_position` order.
- **Numeric**: `|value − expected_value| ≤ tolerance` on stored data.
  Nothing is "computed by the AI" at answer time.

The SQL is mirrored function-for-function in `@avidia/assessment/score.ts`;
the TypeScript tests pin the semantics so a drift in either implementation
breaks CI.

### 3. Immutability by unique constraint (spec W)

`unique (session_id, question_id)` makes re-answering a hard error surfaced
as "question already answered in this session". Recorded attempts accept no
updates or deletes from any client. Combined with sessions that can only
move forward (`grant update (status, completed_at)` only), a student's
answer history cannot be rewritten — by them or by a bug.

### 4. Sessions are plain state, results are plain counts (spec T/V/X)

`study_sessions` is a client-writable but column-restricted table (create
with a planned count; close as completed/abandoned). Question order comes
from `buildSessionQuestionOrder`, a seeded deterministic shuffle balancing
concepts — explicitly **not adaptive** (non-goal AL). The results screen
shows "you answered N of M correctly" and per-question review; no mastery
scores, weakness labels, or predictions exist anywhere in the schema.

### 5. Optional low-friction telemetry (spec U/AG)

`response_time_ms` and a four-level self-reported `confidence` are captured
if offered, validated, and stored unused — M8 raw material, never M7
feedback to the student.

## Consequences

- Answering requires a round-trip; offline answers cannot be scored locally
  (accepted: the key must never ship to the device). Cached study content
  still renders offline; submission waits for connectivity.
- The double-maintained scorer (SQL + TS) is deliberate redundancy; the
  contract tests are the enforcement.
- M8 inherits attempts it can trust: every row was scored by the database
  against server-held answers, timestamped, immutable.
