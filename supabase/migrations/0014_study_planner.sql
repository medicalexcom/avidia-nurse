-- ===========================================================================
-- 0014_study_planner.sql — M13 (spec B/AB/AL/AM/AN/AO)
--
-- Server-side persistence for the intelligent study planner:
--
--   * planner_settings   — one row per user: availability preset + per-weekday
--                          minutes (preferences, not judgments — spec C) and
--                          notification preferences (all reminder toggles
--                          default OFF: conservative opt-in, spec AB).
--   * study_plans        — plan revisions. Regeneration NEVER mutates history
--                          (spec AM): the previous active plan is flipped to
--                          'superseded' and a new revision is inserted, so the
--                          full plan lineage stays auditable.
--   * planned_activities — the per-day activity rows of a plan. Completion is
--                          evidence-based (spec U): an activity leaves
--                          'planned' only by binding to an ACTUAL session row
--                          (study_sessions or simulation_sessions), and each
--                          session can satisfy at most one activity ever
--                          (spec AN idempotency, enforced by unique indexes).
--
-- All writes flow through SECURITY DEFINER RPCs; clients get read-only RLS
-- access to their own rows (spec AO). The planner engine itself is pure
-- TypeScript (packages/planner) — this schema only stores its output.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- planner_settings (spec B/C/AB)
-- ---------------------------------------------------------------------------

create table public.planner_settings (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  preset text not null default 'standard'
    check (preset in ('light', 'standard', 'intensive', 'custom')),
  -- Seven integers, Sunday-first, each clamped 0..240 by the check below and
  -- again by the pure engine (availability.clampMinutes).
  minutes_by_weekday jsonb not null default '[45,45,45,45,45,45,45]'::jsonb
    check (
      jsonb_typeof(minutes_by_weekday) = 'array'
      and jsonb_array_length(minutes_by_weekday) = 7
    ),
  -- Conservative notification defaults: everything opt-in (spec AB).
  study_reminders boolean not null default false,
  review_reminders boolean not null default false,
  exam_reminders boolean not null default false,
  reminder_hour integer not null default 18 check (reminder_hour between 0 and 23),
  quiet_start_hour integer not null default 22 check (quiet_start_hour between 0 and 23),
  quiet_end_hour integer not null default 7 check (quiet_end_hour between 0 and 23),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger planner_settings_set_updated_at
  before update on public.planner_settings
  for each row execute function public.set_updated_at();

alter table public.planner_settings enable row level security;
alter table public.planner_settings force row level security;

-- Settings are plain per-user preferences, so direct RLS writes are fine —
-- there is nothing to cross-validate beyond "it is your own row".
create policy planner_settings_select_own on public.planner_settings
  for select using (user_id = (select auth.uid()));
create policy planner_settings_insert_own on public.planner_settings
  for insert with check (user_id = (select auth.uid()));
create policy planner_settings_update_own on public.planner_settings
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on table public.planner_settings from anon;

-- ---------------------------------------------------------------------------
-- study_plans (spec AL/AM)
-- ---------------------------------------------------------------------------

create table public.study_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  revision integer not null check (revision >= 1),
  status text not null default 'active' check (status in ('active', 'superseded')),
  horizon_start date not null,
  horizon_end date not null,
  time_zone text not null,
  rules_version integer not null,
  total_planned_minutes integer not null check (total_planned_minutes >= 0),
  total_need_minutes integer not null check (total_need_minutes >= 0),
  capacity_minutes integer not null check (capacity_minutes >= 0),
  over_capacity boolean not null default false,
  created_at timestamptz not null default now()
);

-- Exactly one live plan per student; history keeps every superseded revision.
create unique index study_plans_one_active_per_user
  on public.study_plans (user_id) where status = 'active';
create unique index study_plans_user_revision_idx
  on public.study_plans (user_id, revision);

alter table public.study_plans enable row level security;
alter table public.study_plans force row level security;

create policy study_plans_select_own on public.study_plans
  for select using (user_id = (select auth.uid()));

-- No insert/update/delete policies: plans change only through the RPCs below.
revoke all on table public.study_plans from anon;

-- ---------------------------------------------------------------------------
-- planned_activities (spec M/U/AN)
-- ---------------------------------------------------------------------------

create table public.planned_activities (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.study_plans (id) on delete cascade,
  course_id uuid not null references public.courses (id) on delete cascade,
  activity_date date not null,
  position integer not null check (position >= 0),
  -- Only existing learning experiences (spec M) — the planner invents nothing.
  activity_type text not null check (
    activity_type in (
      'start_today',
      'due_review',
      'targeted_practice',
      'rapid_response',
      'medication_lab',
      'priority_challenge',
      'find_the_danger',
      'boss_battle',
      'simulation'
    )
  ),
  concept_id uuid null references public.concepts (id) on delete cascade,
  mode_id text null,
  minutes integer not null check (minutes between 1 and 240),
  reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  status text not null default 'planned' check (
    status in ('planned', 'started', 'completed', 'skipped', 'superseded', 'expired')
  ),
  -- Evidence bindings (spec U): exactly one of these may be set, and a given
  -- session row can satisfy at most one planned activity EVER (spec AN).
  session_id uuid null references public.study_sessions (id) on delete set null,
  simulation_session_id uuid null references public.simulation_sessions (id) on delete set null,
  started_at timestamptz null,
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  check (session_id is null or simulation_session_id is null)
);

create index planned_activities_plan_date_idx
  on public.planned_activities (plan_id, activity_date, position);
create unique index planned_activities_session_once
  on public.planned_activities (session_id) where session_id is not null;
create unique index planned_activities_simulation_session_once
  on public.planned_activities (simulation_session_id)
  where simulation_session_id is not null;

alter table public.planned_activities enable row level security;
alter table public.planned_activities force row level security;

create policy planned_activities_select_own on public.planned_activities
  for select using (
    exists (
      select 1 from public.study_plans p
      where p.id = planned_activities.plan_id
        and p.user_id = (select auth.uid())
    )
  );

-- Writes only via RPCs.
revoke all on table public.planned_activities from anon;

-- ---------------------------------------------------------------------------
-- save_study_plan — transactional supersede + insert (spec AL/AM/AO)
--
-- p_plan shape (produced by packages/planner createStudyPlan):
-- {
--   "horizonStart": "2026-08-14", "horizonEnd": "2026-08-27",
--   "timeZone": "America/New_York", "rulesVersion": 1,
--   "totalPlannedMinutes": 315, "totalNeedMinutes": 400,
--   "capacityMinutes": 315, "overCapacity": true,
--   "activities": [ { "courseId": "...", "date": "2026-08-14", "position": 0,
--                     "type": "targeted_practice", "conceptId": "..."|null,
--                     "modeId": "who_first"|null, "minutes": 15,
--                     "reasons": [ { "code": "exam_soon", ... } ] }, ... ]
-- }
-- ---------------------------------------------------------------------------

create or replace function public.save_study_plan(p_plan jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_plan_id uuid;
  v_revision integer;
  v_activity jsonb;
  v_position integer := 0;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_plan is null or jsonb_typeof(p_plan -> 'activities') <> 'array' then
    raise exception 'invalid plan payload';
  end if;

  -- Every activity must target a course the caller owns (spec AO): a plan can
  -- never smuggle rows pointing at someone else's course.
  if exists (
    select 1
    from jsonb_array_elements(p_plan -> 'activities') a
    where not exists (
      select 1 from public.courses c
      where c.id = (a ->> 'courseId')::uuid and c.user_id = v_user_id
    )
  ) then
    raise exception 'course not found';
  end if;

  -- Supersede the previous revision without touching completed history
  -- (spec AM/Z): finished/skipped rows keep their status; only still-pending
  -- rows are marked superseded.
  update public.planned_activities pa
  set status = 'superseded'
  from public.study_plans p
  where pa.plan_id = p.id
    and p.user_id = v_user_id
    and p.status = 'active'
    and pa.status in ('planned', 'started');

  update public.study_plans
  set status = 'superseded'
  where user_id = v_user_id and status = 'active';

  select coalesce(max(revision), 0) + 1 into v_revision
  from public.study_plans where user_id = v_user_id;

  insert into public.study_plans (
    user_id, revision, status, horizon_start, horizon_end, time_zone,
    rules_version, total_planned_minutes, total_need_minutes,
    capacity_minutes, over_capacity
  ) values (
    v_user_id, v_revision, 'active',
    (p_plan ->> 'horizonStart')::date,
    (p_plan ->> 'horizonEnd')::date,
    coalesce(p_plan ->> 'timeZone', 'UTC'),
    coalesce((p_plan ->> 'rulesVersion')::integer, 1),
    coalesce((p_plan ->> 'totalPlannedMinutes')::integer, 0),
    coalesce((p_plan ->> 'totalNeedMinutes')::integer, 0),
    coalesce((p_plan ->> 'capacityMinutes')::integer, 0),
    coalesce((p_plan ->> 'overCapacity')::boolean, false)
  ) returning id into v_plan_id;

  for v_activity in select * from jsonb_array_elements(p_plan -> 'activities') loop
    insert into public.planned_activities (
      plan_id, course_id, activity_date, position, activity_type,
      concept_id, mode_id, minutes, reasons
    ) values (
      v_plan_id,
      (v_activity ->> 'courseId')::uuid,
      (v_activity ->> 'date')::date,
      coalesce((v_activity ->> 'position')::integer, v_position),
      v_activity ->> 'type',
      nullif(v_activity ->> 'conceptId', '')::uuid,
      nullif(v_activity ->> 'modeId', ''),
      (v_activity ->> 'minutes')::integer,
      coalesce(v_activity -> 'reasons', '[]'::jsonb)
    );
    v_position := v_position + 1;
  end loop;

  return v_plan_id;
end;
$$;

revoke all on function public.save_study_plan(jsonb) from public, anon;
grant execute on function public.save_study_plan(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- start_planned_activity — mark an activity started (spec U). Idempotent:
-- re-starting a started activity is a no-op; completed/skipped rows refuse.
-- ---------------------------------------------------------------------------

create or replace function public.start_planned_activity(p_activity_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_status text;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select pa.status into v_status
  from public.planned_activities pa
  join public.study_plans p on p.id = pa.plan_id
  where pa.id = p_activity_id and p.user_id = v_user_id
  for update of pa;

  if v_status is null then
    raise exception 'activity not found';
  end if;
  if v_status = 'started' then
    return; -- idempotent
  end if;
  if v_status <> 'planned' then
    raise exception 'activity is not pending';
  end if;

  update public.planned_activities
  set status = 'started', started_at = now()
  where id = p_activity_id;
end;
$$;

revoke all on function public.start_planned_activity(uuid) from public, anon;
grant execute on function public.start_planned_activity(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- complete_planned_activity — bind a COMPLETED session as evidence and mark
-- the activity completed (spec U/AN). The session must belong to the caller,
-- match the activity's course, and not already satisfy another activity.
-- Exactly one of p_session_id / p_simulation_session_id must be provided.
-- ---------------------------------------------------------------------------

create or replace function public.complete_planned_activity(
  p_activity_id uuid,
  p_session_id uuid default null,
  p_simulation_session_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_course_id uuid;
  v_status text;
  v_completed_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if (p_session_id is null) = (p_simulation_session_id is null) then
    raise exception 'exactly one session reference is required';
  end if;

  select pa.course_id, pa.status into v_course_id, v_status
  from public.planned_activities pa
  join public.study_plans p on p.id = pa.plan_id
  where pa.id = p_activity_id and p.user_id = v_user_id
  for update of pa;

  if v_status is null then
    raise exception 'activity not found';
  end if;
  if v_status = 'completed' then
    return; -- idempotent
  end if;
  if v_status not in ('planned', 'started') then
    raise exception 'activity is not pending';
  end if;

  if p_session_id is not null then
    select s.completed_at into v_completed_at
    from public.study_sessions s
    join public.courses c on c.id = s.course_id
    where s.id = p_session_id
      and s.course_id = v_course_id
      and s.status = 'completed'
      and c.user_id = v_user_id;
  else
    select s.completed_at into v_completed_at
    from public.simulation_sessions s
    where s.id = p_simulation_session_id
      and s.course_id = v_course_id
      and s.status = 'completed'
      and s.user_id = v_user_id;
  end if;

  if v_completed_at is null then
    raise exception 'session not found';
  end if;

  -- The partial unique indexes reject a session already bound elsewhere;
  -- surface that as a clean error rather than a raw constraint violation.
  begin
    update public.planned_activities
    set status = 'completed',
        session_id = p_session_id,
        simulation_session_id = p_simulation_session_id,
        completed_at = v_completed_at
    where id = p_activity_id;
  exception when unique_violation then
    raise exception 'session already satisfies another activity';
  end;
end;
$$;

revoke all on function public.complete_planned_activity(uuid, uuid, uuid) from public, anon;
grant execute on function public.complete_planned_activity(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- skip_planned_activity — the student declines an item (spec U). Idempotent.
-- ---------------------------------------------------------------------------

create or replace function public.skip_planned_activity(p_activity_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_status text;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select pa.status into v_status
  from public.planned_activities pa
  join public.study_plans p on p.id = pa.plan_id
  where pa.id = p_activity_id and p.user_id = v_user_id
  for update of pa;

  if v_status is null then
    raise exception 'activity not found';
  end if;
  if v_status = 'skipped' then
    return; -- idempotent
  end if;
  if v_status not in ('planned', 'started') then
    raise exception 'activity is not pending';
  end if;

  update public.planned_activities
  set status = 'skipped'
  where id = p_activity_id;
end;
$$;

revoke all on function public.skip_planned_activity(uuid) from public, anon;
grant execute on function public.skip_planned_activity(uuid) to authenticated;
