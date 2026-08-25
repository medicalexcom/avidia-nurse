# Content review: it already existed — the gate to it didn't

Date: 2026-08-25. Follow-on to the same day's Stage 1 live-verification
work and the roadmap comparison. This entry is its own investigation, not
an addendum, because the finding changed what "build the content-review
tool" actually meant.

## What was asked

After comparing the live app against a separate product roadmap, the
founder confirmed building "the content-review tool" (reviewer screen +
backend to approve/edit/reject generated questions) as the concrete unblock
for the roadmap's P0 "author seed content" item.

## What was actually there

Before writing anything, the existing `content-review` edge function
(`supabase/functions/content-review/index.ts`) and its screen
(`app/(app)/review.tsx`) were checked against `origin/main` (confirmed via
`git fetch` — not just the local clone) rather than assumed. They were
already there, already merged, and already the real thing: a `list`/`decide`
action-discriminated endpoint gated by `profiles.role = 'reviewer'`, a
`ReviewQueueScreen` that lets a reviewer edit stem/rationale/option text and
approve or reject, and a route wired into the Profile screen.

Live-verified directly, not assumed:

- `OPTIONS` preflight against the deployed function returns the correct CORS
  headers (`access-control-allow-methods: POST, OPTIONS`, etc.) — the CORS
  fix visible in its git history is live, not just committed.
- Unauthenticated `POST` returns `401 UNAUTHORIZED_NO_AUTH_HEADER` at the
  Supabase gateway (its "Verify JWT" setting is correctly ON) — reachable
  and correctly gated.
- `select id, email, role from public.profiles` (read-only, run directly):
  the founder's one account already has `role = 'reviewer'`. Nothing to
  grant.

So the screen, the backend, and the founder's own access were already
100% done. Nothing needed to be built there.

## What was actually missing

`select status, count(*) from public.questions group by status` (read-only,
run directly) showed `active: 116`, `flagged: 3`, and — importantly —
**zero rows with `status = 'generated'`**. The review tool handles exactly
`generated` and `flagged`, so an empty `generated` bucket meant almost
nothing ever reached it.

Tracing why: `packages/assessment/src/validate.ts`'s clinical validation
pipeline (the thing that runs on every AI-drafted question before it's
allowed into the database at all) set `status: flags.length > 0 ? 'flagged'
: 'active'`. Every question that passed automated validation went straight
to `active` — live to students — with no human ever seeing it. Only the
minority the automated checker itself flagged ever landed in the review
queue. `packages/domain/src/questions.ts`'s own lifecycle comment confirmed
this was known, not accidental: `'generated' is reserved for a future
human-review workflow where items persist before validation` — a workflow
that was never wired up, even after the review tool itself got built.

The two SQL RPCs that actually insert generated questions
(`apply_question_generation`, migration 0007; `apply_ondemand_question_generation`,
migration 0020) independently enforced the same thing at the database layer:
`case when v_question ->> 'status' in ('active', 'flagged') then ... else
'flagged' end` — even if the TypeScript layer had sent `'generated'`, the
database would have silently coerced it to `'flagged'`.

## What changed

Code (delivered as files, no migration involved):

- `packages/assessment/src/validate.ts` — clean-passing questions now get
  `status: 'generated'` instead of `'active'`; flagged questions are
  unchanged. Updated the type, the module doc comment, and the field
  comment to match.
- `packages/assessment/src/rpc.ts` — `QuestionRpcEntry.status` type widened
  from `'active' | 'flagged'` to `'generated' | 'flagged'`; comment updated.
- `packages/domain/src/questions.ts` — lifecycle comment corrected: this is
  no longer a reserved future state, it's the actual default.
- `apps/worker/src/questions.ts` — comment updated to describe the review
  gate instead of the old "flagged questions land excluded" framing.
- `packages/assessment/src/evalFixtures.ts` — fixture comment corrected.
- Tests updated to match (`packages/assessment/src/rpc.test.ts`,
  `packages/assessment/src/validate.test.ts`,
  `apps/worker/src/questions.test.ts`) — 4 assertions that expected
  `'active'` now expect `'generated'`.

All three touched packages pass their full test suites after the change
(`@avidia/assessment`: 52 tests, `@avidia/worker`: 17 relevant tests,
`@avidia/domain`: 81 tests) and typecheck clean.

Database (staged as `supabase/migrations/0023_generated_status_review_gate.sql`
for the founder to run — `CREATE OR REPLACE FUNCTION` is schema DDL against
production, outside what this session executes directly):

- `apply_question_generation` and `apply_ondemand_question_generation`:
  widen the status allow-list to accept `'generated'` (previously only
  `'active'`/`'flagged'` were accepted; anything else silently became
  `'flagged'` — that fallback is unchanged, `'generated'` is additive).
- `apply_question_generation`'s own orphan-retirement sweep, and the
  `cleanup_course_questions_after_document_delete` trigger function (fires
  when a source document is deleted): both widened from `status in
('active', 'flagged')` to also include `'generated'`, so a question still
  awaiting its first review gets retired too if its source evidence
  disappears, instead of lingering forever unreachable by either students
  or the retirement logic.

### Verification before asking the founder to run it

Rather than asking for trust on a production schema change, the migration
was tested against a real, disposable local Postgres 16 instance: `initdb`,
then a minimal stand-in schema matching the real column names/types the
three functions touch (`questions`, `question_options`, `question_sources`,
`courses`, `documents`, `concepts`, `concept_aliases`, `source_chunks`):

1. The migration file applied cleanly — all three
   `CREATE OR REPLACE FUNCTION` statements succeeded, and the `revoke ...
from public, anon, authenticated` statements matched the roles-not-yet-
   existing case correctly (only failed until `anon`/`authenticated`/
   `service_role` roles were added to the stub, exactly as expected since
   the real Supabase project already has them).
2. Called `apply_ondemand_question_generation` with a payload whose
   question has `status: 'generated'` — the row landed as `'generated'`,
   not coerced to anything else.
3. Called it again with a garbage `status` value — confirmed the safety
   fallback still lands `'flagged'`, unchanged from before.
4. Inserted an orphaned `'generated'`-status question with no
   `question_sources` row, then called `apply_question_generation` — the
   sweep retired it, confirming the widened retirement logic actually
   fires.

The disposable Postgres instance and database were torn down afterward;
nothing was left running.

## What this doesn't do

- It doesn't touch the 116 questions already `status = 'active'` in the
  live database. None of them were ever reviewed by a human — they only
  passed the automated validator, under the old (now-changed) rule.
  Retroactively pulling any of them back into the review queue is a
  separate decision this session didn't make.
- It doesn't change anything about `simulation_cases` (case-study content) —
  that's a different table with its own lifecycle, out of scope here.
- The review tool's own scope is unchanged: edits touch wording only
  (stem, rationale, option text), never `is_correct`/`correct_position` —
  a question with a wrong answer key gets rejected, not hand-fixed, exactly
  as the tool's existing docstring already specified.

## Still open

- Migration `0023` needs to be run by the founder in the Supabase SQL
  editor before any of this takes effect live. Until then, the pipeline
  keeps behaving exactly as it does today (clean questions go straight
  `active`).
- Once it's run, the founder still has to actually do the reviewing —
  that's real editorial/clinical work this session doesn't do, unchanged
  from every earlier note on seed content in `KNOWN_LIMITATIONS.md`.
