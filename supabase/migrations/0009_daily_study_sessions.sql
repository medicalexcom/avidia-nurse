-- ===========================================================================
-- 0009 — Daily adaptive study experience (M9)
--
-- Adds the persistence the daily "START TODAY" flow needs and NOTHING more
-- (spec Y: avoid redundant copies of attempt data — attempts remain the
-- single source of answer truth from M7, mastery remains M8's):
--
--   * study_sessions.requested_duration_minutes — what the student asked for
--     (5/10/20/45 in the app; the constraint is deliberately looser so the
--     presets can change without a migration). Actual duration is derived
--     from started_at → completed_at; activities completed are counted from
--     question_attempts. Nothing is duplicated.
--   * study_session_plan — the ordered question plan of a session, written
--     once at session start. This is what makes RESUME possible (spec O):
--     after an app restart the client reloads the plan, subtracts the
--     attempts already recorded (idempotent by unique(session,question) —
--     resume can never double-update mastery), and continues at the first
--     unanswered item. Skips (spec AB) are tracked explicitly on the plan
--     row: a skip is neither correct nor incorrect and never touches
--     mastery.
--
-- Security model (matches M7/M8): owner-only visibility enforced by RLS +
-- column-level grants; plan rows are insert-once (no delete, and the ONLY
-- updatable column is skipped_at); every policy walks up to the owning
-- course's user_id.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- study_sessions: requested duration (spec B/D/Y)
-- ---------------------------------------------------------------------------

alter table public.study_sessions
  add column requested_duration_minutes integer null
    check (requested_duration_minutes is null or requested_duration_minutes between 1 and 120);

comment on column public.study_sessions.requested_duration_minutes is
  'Duration the student chose at launch (minutes). Null for pre-M9 sessions '
  'and plain practice. Actual duration derives from started_at/completed_at.';

-- Column-level grants are additive; clients may now set the duration at
-- insert. It is intentionally NOT updatable after creation.
grant insert (requested_duration_minutes)
  on table public.study_sessions to authenticated;

-- ---------------------------------------------------------------------------
-- study_session_plan: the persisted per-session question order (spec O/AB)
-- ---------------------------------------------------------------------------

create table public.study_session_plan (
  session_id uuid not null references public.study_sessions (id) on delete cascade,
  -- 1-based position in the plan as ordered at session start. In-session
  -- adaptation (spec J) reorders the REMAINING items in memory; the stored
  -- plan is the deterministic baseline a resume falls back to (ADR-0025).
  position integer not null check (position between 1 and 50),
  question_id uuid not null references public.questions (id) on delete cascade,
  -- Spec AB: a skip is recorded, never silently treated as an answer.
  skipped_at timestamptz null,
  created_at timestamptz not null default now(),
  primary key (session_id, position),
  unique (session_id, question_id)
);

create index study_session_plan_question_idx
  on public.study_session_plan (question_id);

alter table public.study_session_plan enable row level security;
alter table public.study_session_plan force row level security;

-- Owner reads their own plans (via session → course → user).
create policy study_session_plan_select_own on public.study_session_plan
  for select
  using (
    exists (
      select 1
      from public.study_sessions s
      join public.courses c on c.id = s.course_id
      where s.id = study_session_plan.session_id
        and c.user_id = (select auth.uid())
    )
  );

-- Owner writes plan rows only for their OWN, still-open session, and only
-- for questions of the SAME course. The questions subquery additionally runs
-- under the questions RLS for the caller, so only ACTIVE questions of an
-- owned course qualify — a plan can never reference someone else's bank.
create policy study_session_plan_insert_own on public.study_session_plan
  for insert
  with check (
    exists (
      select 1
      from public.study_sessions s
      join public.courses c on c.id = s.course_id
      join public.questions q on q.id = study_session_plan.question_id
        and q.course_id = s.course_id
      where s.id = study_session_plan.session_id
        and s.status = 'in_progress'
        and c.user_id = (select auth.uid())
    )
  );

-- The ONLY mutation is marking a skip on an open session (column grant
-- below restricts the writable column to skipped_at).
create policy study_session_plan_update_own on public.study_session_plan
  for update
  using (
    exists (
      select 1
      from public.study_sessions s
      join public.courses c on c.id = s.course_id
      where s.id = study_session_plan.session_id
        and s.status = 'in_progress'
        and c.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1
      from public.study_sessions s
      join public.courses c on c.id = s.course_id
      where s.id = study_session_plan.session_id
        and c.user_id = (select auth.uid())
    )
  );

revoke all on table public.study_session_plan from anon, authenticated;
grant select (session_id, position, question_id, skipped_at, created_at)
  on table public.study_session_plan to authenticated;
grant insert (session_id, position, question_id)
  on table public.study_session_plan to authenticated;
grant update (skipped_at)
  on table public.study_session_plan to authenticated;
-- No delete grant: plans are append-only history, removed only by cascade.
