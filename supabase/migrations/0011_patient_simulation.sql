-- ===========================================================================
-- 0011 — Stateful patient simulation engine (M11)
--
-- CORE PRINCIPLE (spec, Playbook §19): THE LLM IS NOT THE SIMULATION ENGINE.
-- Patient state, action validity, state transitions, critical events,
-- scoring, and outcomes live in structured, versioned, deterministic data
-- and deterministic SQL — no AI provider is ever consulted here.
--
-- This migration is the AUTHORITATIVE runtime interpreter. It mirrors, rule
-- for rule and constant for constant, the executable specification in
-- packages/simulation/src (engine.ts / score.ts / redact.ts / evidence.ts),
-- under the same double-maintenance contract as scoring and mastery
-- (ADR-0020/ADR-0022; here ADR-0028). Any semantic change requires bumping
-- SIMULATION_ENGINE_VERSION in BOTH implementations (spec AY); the TS test
-- suite pins every behavior the functions below reproduce.
--
-- Model:
--   * simulation_cases     versioned case definitions (spec A/AA/AX). The
--                          full `definition` jsonb is SERVER-ONLY: clients
--                          may browse metadata but never the rulebook,
--                          hidden findings, classifications, or answers
--                          (spec N).
--   * simulation_sessions  one row per student run (spec V). The
--                          authoritative `state` jsonb is SERVER-ONLY; the
--                          client only ever receives the redacted view
--                          built by sim_client_view (spec N/AJ).
--   * simulation_actions   append-only action history (spec W): every
--                          submission — accepted or rejected — with its full
--                          event record and the exact payload returned.
--                          History + case definition fully reconstruct the
--                          session (replay, spec W/AR).
--   * mastery_events       extended so a completed simulation feeds the ONE
--                          existing mastery model (spec T/U): same v1
--                          constants as question attempts, one bounded event
--                          per mapped concept, idempotent per session.
--
-- Concurrency + idempotency (spec Y/Z/BC): simulation_act locks the session
-- row FOR UPDATE (serializing concurrent submissions), and an
-- idempotency key that was already processed returns the ORIGINAL stored
-- result without re-running anything — a double-tapped "Administer" can
-- never administer twice. Every action is one transaction: state update,
-- history row, and (on completion) score + mastery evidence commit together
-- or not at all.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- simulation_cases (spec A/AA/AB/AX/AY)
-- ---------------------------------------------------------------------------

create table public.simulation_cases (
  id uuid primary key default gen_random_uuid(),
  -- Stable slug, e.g. 'postop_pe'. The app addresses cases by key.
  case_key text not null unique check (length(case_key) between 2 and 80),
  -- Case content version (spec AX): bump on any rule/content change.
  case_version integer not null check (case_version >= 1),
  -- Engine semantics the definition was authored against (spec AY).
  engine_version integer not null check (engine_version >= 1),
  -- Only ACTIVE cases are playable; retirement never deletes (spec AX).
  status text not null default 'active' check (status in ('active', 'retired')),
  title text not null check (length(title) between 2 and 200),
  description text not null,
  difficulty text not null check (difficulty in ('easy', 'moderate', 'hard')),
  scenario_type text not null check (
    scenario_type in ('deterioration', 'medication_safety', 'metabolic', 'general')
  ),
  estimated_duration_minutes integer not null
    check (estimated_duration_minutes between 1 and 120),
  -- The FULL SimulationCaseDefinition (packages/simulation/src/types.ts).
  -- SERVER-ONLY (spec N): contains hidden findings, rules, classifications,
  -- scoring criteria — excluded from client column grants below.
  definition jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger simulation_cases_set_updated_at
  before update on public.simulation_cases
  for each row execute function public.set_updated_at();

alter table public.simulation_cases enable row level security;
alter table public.simulation_cases force row level security;

-- Any signed-in student may browse ACTIVE case metadata (the library screen).
create policy simulation_cases_select_active on public.simulation_cases
  for select
  using (simulation_cases.status = 'active');

-- No client write path at all: cases arrive via migrations/seed (spec AB —
-- only validated definitions are ever inserted; the validation gate is
-- packages/simulation/src/validateCase.ts, run at seed-generation time).
revoke all on table public.simulation_cases from anon, authenticated;
grant select (
  id, case_key, case_version, engine_version, status, title, description,
  difficulty, scenario_type, estimated_duration_minutes, created_at
) on table public.simulation_cases to authenticated;

-- ---------------------------------------------------------------------------
-- simulation_sessions (spec V/X/Z/AW)
-- ---------------------------------------------------------------------------

create table public.simulation_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null references public.courses (id) on delete cascade,
  case_id uuid not null references public.simulation_cases (id) on delete restrict,
  -- Pinned at start (spec AX/AY): a session is replayable against exactly
  -- the definition version it ran under, even after the case is bumped.
  case_version integer not null,
  engine_version integer not null,
  status text not null default 'active'
    check (status in ('active', 'completed', 'abandoned')),
  -- The authoritative PatientState (packages/simulation/src/types.ts).
  -- SERVER-ONLY (spec N): true vitals, hidden findings, rule state. The
  -- client only ever receives sim_client_view over this.
  state jsonb not null,
  -- Set at completion from the end effect's outcome (spec AP).
  outcome_id text null,
  -- Deterministic SimulationScore, computed once at completion (spec S).
  -- SERVER-ONLY column; released through get_simulation_debrief.
  score jsonb null,
  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  updated_at timestamptz not null default now(),
  constraint simulation_sessions_completed_consistency check (
    (status = 'completed') = (outcome_id is not null)
  )
);

create index simulation_sessions_user_course_idx
  on public.simulation_sessions (user_id, course_id, status);
create index simulation_sessions_case_idx on public.simulation_sessions (case_id);

create trigger simulation_sessions_set_updated_at
  before update on public.simulation_sessions
  for each row execute function public.set_updated_at();

alter table public.simulation_sessions enable row level security;
alter table public.simulation_sessions force row level security;

-- Owner-only visibility (spec AW): User B can never see User A's sessions.
create policy simulation_sessions_select_own on public.simulation_sessions
  for select
  using (
    simulation_sessions.user_id = (select auth.uid())
    and exists (
      select 1 from public.courses c
      where c.id = simulation_sessions.course_id
        and c.user_id = (select auth.uid())
    )
  );

-- No insert/update/delete policies or grants: the ONLY write paths are the
-- SECURITY DEFINER RPCs below (spec V/X/Z — same pattern as
-- question_attempts in 0007).
revoke all on table public.simulation_sessions from anon, authenticated;
grant select (
  id, user_id, course_id, case_id, case_version, engine_version, status,
  outcome_id, started_at, completed_at, updated_at
) on table public.simulation_sessions to authenticated;

-- ---------------------------------------------------------------------------
-- simulation_actions (spec W/Y) — append-only history
-- ---------------------------------------------------------------------------

create table public.simulation_actions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.simulation_sessions (id) on delete cascade,
  -- Submission sequence (1-based) — includes REJECTED submissions, so the
  -- audit trail shows everything the student tried (spec W).
  seq integer not null check (seq >= 1),
  action_id text not null,
  params jsonb not null default '{}'::jsonb,
  -- Client-generated key (spec Y): a retried submission with the same key
  -- returns the stored `result` untouched instead of re-processing.
  idempotency_key text null check (
    idempotency_key is null or length(idempotency_key) between 8 and 80
  ),
  -- Null for accepted actions; the ActionRejection code otherwise.
  rejected text null check (
    rejected is null or rejected in (
      'simulation_completed', 'unknown_action',
      'missing_prompt_param', 'unknown_prompt'
    )
  ),
  -- Simulated clock AFTER this submission was processed (spec H).
  sim_time_minutes integer not null check (sim_time_minutes >= 0),
  -- The FULL event record — visible AND hidden events (spec I/N).
  -- SERVER-ONLY column: hidden events reach the student only in the debrief.
  events jsonb not null default '[]'::jsonb,
  -- The exact payload simulation_act returned — replayed verbatim for
  -- idempotent retries (spec Y). SERVER-ONLY column.
  result jsonb not null,
  created_at timestamptz not null default now(),
  constraint simulation_actions_session_seq_unique unique (session_id, seq)
);

create unique index simulation_actions_idempotency_unique
  on public.simulation_actions (session_id, idempotency_key)
  where idempotency_key is not null;
create index simulation_actions_session_idx
  on public.simulation_actions (session_id, seq);

alter table public.simulation_actions enable row level security;
alter table public.simulation_actions force row level security;

create policy simulation_actions_select_own on public.simulation_actions
  for select
  using (
    exists (
      select 1 from public.simulation_sessions s
      where s.id = simulation_actions.session_id
        and s.user_id = (select auth.uid())
    )
  );

-- Append-only (spec W): no update/delete path exists for ANYONE — rows are
-- only ever inserted by simulation_act. Clients may read the safe columns
-- of their own history; events/result stay server-side (spec N).
revoke all on table public.simulation_actions from anon, authenticated;
grant select (
  id, session_id, seq, action_id, params, rejected, sim_time_minutes, created_at
) on table public.simulation_actions to authenticated;

-- ---------------------------------------------------------------------------
-- mastery_events: simulations feed the ONE mastery model (spec T/U)
-- ---------------------------------------------------------------------------

alter table public.mastery_events
  alter column attempt_id drop not null;

alter table public.mastery_events
  add column simulation_session_id uuid null
    references public.simulation_sessions (id) on delete cascade;

-- Every mastery event has EXACTLY ONE source: a question attempt or a
-- completed simulation session (spec T — no orphan evidence, no double
-- attribution).
alter table public.mastery_events
  add constraint mastery_events_exactly_one_source check (
    (attempt_id is not null)::integer
      + (simulation_session_id is not null)::integer = 1
  );

-- One evidence event per concept per simulation session, ever (spec U
-- idempotency backstop — completion itself is guarded by the status
-- transition, this makes double application impossible at the data layer).
create unique index mastery_events_simulation_concept_unique
  on public.mastery_events (simulation_session_id, concept_id)
  where simulation_session_id is not null;

grant select (simulation_session_id)
  on table public.mastery_events to authenticated;

-- ===========================================================================
-- Deterministic interpreter (spec C/D/E/G/H/I/M/N/P) — mirrors engine.ts.
--
-- All sim_* helpers are INTERNAL: execute is revoked from clients; only the
-- SECURITY DEFINER RPCs call them. State and definitions are jsonb in the
-- exact shapes of packages/simulation/src/types.ts.
-- ===========================================================================

-- Hard physiologic bounds (spec J) — mirrors PHYSIOLOGIC_BOUNDS. No rule
-- effect may ever push a vital outside these, regardless of the case.
create or replace function public.sim_clamp(
  p_vital text,
  p_value numeric,
  p_min numeric default null,
  p_max numeric default null
)
returns numeric
language plpgsql
immutable
as $$
declare
  v_min numeric;
  v_max numeric;
begin
  case p_vital
    when 'hr' then v_min := 20; v_max := 220;
    when 'sbp' then v_min := 40; v_max := 260;
    when 'dbp' then v_min := 20; v_max := 160;
    when 'rr' then v_min := 4; v_max := 60;
    when 'spo2' then v_min := 50; v_max := 100;
    when 'temp_c' then v_min := 30; v_max := 43;
    when 'pain' then v_min := 0; v_max := 10;
    when 'glucose' then v_min := 10; v_max := 900;
    else raise exception 'unknown vital %', p_vital;
  end case;
  return least(
    least(v_max, coalesce(p_max, v_max)),
    greatest(greatest(v_min, coalesce(p_min, v_min)), p_value)
  );
end;
$$;

-- Condition evaluation — mirrors conditionMet() (10 kinds, spec D/P).
create or replace function public.sim_condition_met(p_state jsonb, p_cond jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  v_kind text := p_cond ->> 'kind';
  v_vital text;
begin
  if v_kind = 'time_at_least' then
    return (p_state ->> 'timeMinutes')::numeric >= (p_cond ->> 'minutes')::numeric;
  elsif v_kind = 'phase_is' then
    return (p_state ->> 'phase') = (p_cond ->> 'phase');
  elsif v_kind = 'vital_at_most' then
    v_vital := p_cond ->> 'vital';
    return (p_state -> 'vitals' ->> v_vital) is not null
      and (p_state -> 'vitals' ->> v_vital)::numeric <= (p_cond ->> 'value')::numeric;
  elsif v_kind = 'vital_at_least' then
    v_vital := p_cond ->> 'vital';
    return (p_state -> 'vitals' ->> v_vital) is not null
      and (p_state -> 'vitals' ->> v_vital)::numeric >= (p_cond ->> 'value')::numeric;
  elsif v_kind = 'action_done' then
    return exists (
      select 1 from jsonb_array_elements(p_state -> 'actionLog') entry
      where entry ->> 'actionId' = p_cond ->> 'actionId'
    );
  elsif v_kind = 'action_not_done' then
    return not exists (
      select 1 from jsonb_array_elements(p_state -> 'actionLog') entry
      where entry ->> 'actionId' = p_cond ->> 'actionId'
    );
  elsif v_kind = 'finding_revealed' then
    return coalesce(
      (p_state -> 'findings' -> (p_cond ->> 'findingId') ->> 'revealed')::boolean,
      false
    );
  elsif v_kind = 'deterioration_at_least' then
    return (p_state ->> 'deteriorationLevel')::numeric >= (p_cond ->> 'level')::numeric;
  elsif v_kind = 'flag_set' then
    return p_state -> 'safetyFlags' ? (p_cond ->> 'flag');
  elsif v_kind = 'flag_not_set' then
    return not (p_state -> 'safetyFlags' ? (p_cond ->> 'flag'));
  else
    raise exception 'unknown condition kind %', v_kind;
  end if;
end;
$$;

-- Effect application — mirrors applyEffect() (13 kinds, spec G/I).
-- ctx = {"state": PatientState, "events": [...], "phases_entered": [...]}.
create or replace function public.sim_apply_effect(
  p_def jsonb,
  p_ctx jsonb,
  p_effect jsonb
)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_state jsonb := p_ctx -> 'state';
  v_events jsonb := p_ctx -> 'events';
  v_phases jsonb := p_ctx -> 'phases_entered';
  v_kind text := p_effect ->> 'kind';
  v_at numeric;
  v_vital text;
  v_cur numeric;
  v_next numeric;
  v_id text;
  v_finding jsonb;
  v_def_row jsonb;
  v_lab jsonb;
  v_new_sched jsonb;
begin
  if (v_state -> 'completed') <> 'null'::jsonb then
    return p_ctx;
  end if;
  v_at := (v_state ->> 'timeMinutes')::numeric;

  if v_kind = 'vital_delta' then
    v_vital := p_effect ->> 'vital';
    if (v_state -> 'vitals' ->> v_vital) is null then
      return p_ctx;
    end if;
    v_cur := (v_state -> 'vitals' ->> v_vital)::numeric;
    v_next := public.sim_clamp(
      v_vital, v_cur + (p_effect ->> 'delta')::numeric,
      (p_effect ->> 'min')::numeric, (p_effect ->> 'max')::numeric
    );
    if v_next <> v_cur then
      v_state := jsonb_set(v_state, array['vitals', v_vital], to_jsonb(v_next));
      v_events := v_events || jsonb_build_array(jsonb_build_object(
        'type', 'vital_change', 'vital', v_vital, 'from', v_cur, 'to', v_next,
        'atMinutes', v_at, 'visible', false
      ));
    end if;

  elsif v_kind = 'vital_set' then
    v_vital := p_effect ->> 'vital';
    v_cur := (v_state -> 'vitals' ->> v_vital)::numeric;
    v_next := public.sim_clamp(v_vital, (p_effect ->> 'value')::numeric);
    if v_cur is distinct from v_next then
      v_state := jsonb_set(v_state, array['vitals', v_vital], to_jsonb(v_next));
      v_events := v_events || jsonb_build_array(jsonb_build_object(
        'type', 'vital_change', 'vital', v_vital,
        'from', coalesce(v_cur, v_next), 'to', v_next,
        'atMinutes', v_at, 'visible', false
      ));
    end if;

  elsif v_kind = 'set_phase' then
    if (v_state ->> 'phase') <> (p_effect ->> 'phase') then
      v_state := jsonb_set(v_state, '{phase}', p_effect -> 'phase');
      v_phases := v_phases || jsonb_build_array(p_effect -> 'phase');
      v_events := v_events || jsonb_build_array(jsonb_build_object(
        'type', 'phase_changed', 'phase', p_effect ->> 'phase',
        'atMinutes', v_at, 'visible', false
      ));
    end if;

  elsif v_kind = 'set_finding_present' then
    v_id := p_effect ->> 'findingId';
    if (v_state -> 'findings' -> v_id) is not null then
      v_state := jsonb_set(
        v_state, array['findings', v_id, 'present'], p_effect -> 'present'
      );
    end if;

  elsif v_kind = 'reveal_finding' then
    v_id := p_effect ->> 'findingId';
    v_finding := v_state -> 'findings' -> v_id;
    select f into v_def_row
    from jsonb_array_elements(p_def -> 'findings') f
    where f ->> 'id' = v_id;
    if v_finding is not null and v_def_row is not null
       and (v_finding ->> 'present')::boolean
       and not (v_finding ->> 'revealed')::boolean then
      v_state := jsonb_set(v_state, array['findings', v_id, 'revealed'], 'true'::jsonb);
      v_events := v_events || jsonb_build_array(jsonb_build_object(
        'type', 'finding_revealed', 'findingId', v_id,
        'system', v_def_row ->> 'system', 'text', v_def_row ->> 'text',
        'atMinutes', v_at, 'visible', true
      ));
    end if;

  elsif v_kind = 'release_lab' then
    v_id := p_effect ->> 'labId';
    v_lab := v_state -> 'labs' -> v_id;
    select l into v_def_row
    from jsonb_array_elements(p_def -> 'labs') l
    where l ->> 'id' = v_id;
    if v_lab is not null and v_def_row is not null
       and not (v_lab ->> 'released')::boolean then
      v_state := jsonb_set(v_state, array['labs', v_id, 'released'], 'true'::jsonb);
      v_events := v_events || jsonb_build_array(jsonb_build_object(
        'type', 'lab_released', 'labId', v_id, 'name', v_def_row ->> 'name',
        'value', v_lab -> 'value', 'unit', v_def_row ->> 'unit',
        'flag', v_lab ->> 'flag', 'atMinutes', v_at, 'visible', true
      ));
    end if;

  elsif v_kind = 'set_lab_value' then
    v_id := p_effect ->> 'labId';
    if (v_state -> 'labs' -> v_id) is not null then
      v_state := jsonb_set(v_state, array['labs', v_id, 'value'], p_effect -> 'value');
      v_state := jsonb_set(v_state, array['labs', v_id, 'flag'], p_effect -> 'flag');
    end if;

  elsif v_kind = 'schedule' then
    v_state := jsonb_set(
      v_state, '{scheduled}',
      (v_state -> 'scheduled') || jsonb_build_array(jsonb_build_object(
        'scheduleId', p_effect ->> 'scheduleId',
        'atMinutes', v_at + (p_effect ->> 'afterMinutes')::numeric,
        'effects', p_effect -> 'effects'
      ))
    );

  elsif v_kind = 'cancel_scheduled' then
    select coalesce(jsonb_agg(s order by ord), '[]'::jsonb) into v_new_sched
    from jsonb_array_elements(v_state -> 'scheduled') with ordinality as t(s, ord)
    where s ->> 'scheduleId' <> p_effect ->> 'scheduleId';
    v_state := jsonb_set(v_state, '{scheduled}', v_new_sched);

  elsif v_kind = 'set_deterioration' then
    if (v_state ->> 'deteriorationLevel')::numeric <> (p_effect ->> 'level')::numeric then
      v_state := jsonb_set(v_state, '{deteriorationLevel}', p_effect -> 'level');
      v_events := v_events || jsonb_build_array(jsonb_build_object(
        'type', 'deterioration_changed', 'level', p_effect -> 'level',
        'atMinutes', v_at, 'visible', false
      ));
    end if;

  elsif v_kind = 'add_flag' then
    if not (v_state -> 'safetyFlags' ? (p_effect ->> 'flag')) then
      v_state := jsonb_set(
        v_state, '{safetyFlags}',
        (v_state -> 'safetyFlags') || jsonb_build_array(p_effect -> 'flag')
      );
      v_events := v_events || jsonb_build_array(jsonb_build_object(
        'type', 'safety_flag', 'flag', p_effect ->> 'flag',
        'atMinutes', v_at, 'visible', false
      ));
    end if;

  elsif v_kind = 'patient_statement' then
    select s into v_def_row
    from jsonb_array_elements(p_def -> 'statements') s
    where s ->> 'id' = p_effect ->> 'statementId';
    if v_def_row is not null then
      v_state := jsonb_set(
        v_state, '{statements}',
        (v_state -> 'statements') || jsonb_build_array(jsonb_build_object(
          'statementId', p_effect ->> 'statementId', 'atMinutes', v_at
        ))
      );
      v_events := v_events || jsonb_build_array(jsonb_build_object(
        'type', 'patient_statement', 'text', v_def_row ->> 'text',
        'atMinutes', v_at, 'visible', true
      ));
    end if;

  elsif v_kind = 'end' then
    select o into v_def_row
    from jsonb_array_elements(p_def -> 'outcomes') o
    where o ->> 'id' = p_effect ->> 'outcomeId';
    v_state := jsonb_set(v_state, '{completed}', jsonb_build_object(
      'outcomeId', p_effect ->> 'outcomeId', 'atMinutes', v_at
    ));
    v_state := jsonb_set(v_state, '{scheduled}', '[]'::jsonb);
    v_events := v_events || jsonb_build_array(jsonb_build_object(
      'type', 'completed', 'outcomeId', p_effect ->> 'outcomeId',
      'label', coalesce(v_def_row ->> 'label', p_effect ->> 'outcomeId'),
      'atMinutes', v_at, 'visible', true
    ));

  else
    raise exception 'unknown effect kind %', v_kind;
  end if;

  return jsonb_build_object(
    'state', v_state, 'events', v_events, 'phases_entered', v_phases
  );
end;
$$;

-- Rule firing — mirrors fireRule() (once-rules, conditions, spec Y/BA).
create or replace function public.sim_fire_rule(
  p_def jsonb,
  p_ctx jsonb,
  p_rule jsonb
)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_ctx jsonb := p_ctx;
  v_cond jsonb;
  v_effect jsonb;
begin
  if (v_ctx -> 'state' -> 'completed') <> 'null'::jsonb then
    return v_ctx;
  end if;
  if (p_rule ->> 'once')::boolean
     and (v_ctx -> 'state' -> 'firedRules' ? (p_rule ->> 'id')) then
    return v_ctx;
  end if;
  for v_cond in select c from jsonb_array_elements(p_rule -> 'conditions') c loop
    if not public.sim_condition_met(v_ctx -> 'state', v_cond) then
      return v_ctx;
    end if;
  end loop;
  v_ctx := jsonb_set(
    v_ctx, '{state,firedRules}',
    (v_ctx -> 'state' -> 'firedRules') || jsonb_build_array(p_rule -> 'id')
  );
  v_ctx := jsonb_set(
    v_ctx, '{events}',
    (v_ctx -> 'events') || jsonb_build_array(jsonb_build_object(
      'type', 'rule_fired', 'ruleId', p_rule ->> 'id',
      'description', p_rule ->> 'description',
      'atMinutes', (v_ctx -> 'state' ->> 'timeMinutes')::numeric,
      'visible', false
    ))
  );
  for v_effect in select e from jsonb_array_elements(p_rule -> 'effects') e loop
    v_ctx := public.sim_apply_effect(p_def, v_ctx, v_effect);
    if (v_ctx -> 'state' -> 'completed') <> 'null'::jsonb then
      return v_ctx;
    end if;
  end loop;
  return v_ctx;
end;
$$;

-- Due scheduled effects, in (atMinutes, scheduleId) order — mirrors
-- fireDueScheduled() (spec G/H: deterioration does not wait to be looked at).
create or replace function public.sim_fire_due_scheduled(p_def jsonb, p_ctx jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_ctx jsonb := p_ctx;
  v_next jsonb;
  v_remaining jsonb;
  v_effect jsonb;
begin
  loop
    if (v_ctx -> 'state' -> 'completed') <> 'null'::jsonb then
      return v_ctx;
    end if;
    select s into v_next
    from jsonb_array_elements(v_ctx -> 'state' -> 'scheduled') s
    where (s ->> 'atMinutes')::numeric <= (v_ctx -> 'state' ->> 'timeMinutes')::numeric
    order by (s ->> 'atMinutes')::numeric, s ->> 'scheduleId'
    limit 1;
    if v_next is null then
      return v_ctx;
    end if;
    select coalesce(jsonb_agg(s order by ord), '[]'::jsonb) into v_remaining
    from jsonb_array_elements(v_ctx -> 'state' -> 'scheduled')
      with ordinality as t(s, ord)
    where s ->> 'scheduleId' <> v_next ->> 'scheduleId';
    v_ctx := jsonb_set(v_ctx, '{state,scheduled}', v_remaining);
    for v_effect in select e from jsonb_array_elements(v_next -> 'effects') e loop
      v_ctx := public.sim_apply_effect(p_def, v_ctx, v_effect);
      if (v_ctx -> 'state' -> 'completed') <> 'null'::jsonb then
        return v_ctx;
      end if;
    end loop;
  end loop;
end;
$$;

-- Time-/phase-triggered rules to a fixed point (max 10 passes) — mirrors
-- fireBackgroundRules() (spec D/P).
create or replace function public.sim_fire_background_rules(p_def jsonb, p_ctx jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_ctx jsonb := p_ctx;
  v_before integer;
  v_rule jsonb;
begin
  for pass in 0..9 loop
    if (v_ctx -> 'state' -> 'completed') <> 'null'::jsonb then
      return v_ctx;
    end if;
    v_before := jsonb_array_length(v_ctx -> 'state' -> 'firedRules');
    for v_rule in
      select r from jsonb_array_elements(p_def -> 'rules')
        with ordinality as t(r, ord)
      order by ord
    loop
      if (v_ctx -> 'state' -> 'completed') <> 'null'::jsonb then
        exit;
      end if;
      if v_rule -> 'trigger' ->> 'kind' = 'time' then
        v_ctx := public.sim_fire_rule(p_def, v_ctx, v_rule);
      elsif v_rule -> 'trigger' ->> 'kind' = 'phase_enter'
            and (v_ctx -> 'phases_entered' ? (v_rule -> 'trigger' ->> 'phase')) then
        v_ctx := public.sim_fire_rule(p_def, v_ctx, v_rule);
      end if;
    end loop;
    v_ctx := public.sim_fire_due_scheduled(p_def, v_ctx);
    if jsonb_array_length(v_ctx -> 'state' -> 'firedRules') = v_before then
      return v_ctx;
    end if;
  end loop;
  return v_ctx;
end;
$$;

-- Initial patient state — mirrors startState() (spec C).
create or replace function public.sim_start_state(p_def jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_findings jsonb := '{}'::jsonb;
  v_labs jsonb := '{}'::jsonb;
  v_row jsonb;
begin
  for v_row in select f from jsonb_array_elements(p_def -> 'findings') f loop
    v_findings := v_findings || jsonb_build_object(
      v_row ->> 'id',
      jsonb_build_object('present', v_row -> 'presentAtStart', 'revealed', false)
    );
  end loop;
  for v_row in select l from jsonb_array_elements(p_def -> 'labs') l loop
    v_labs := v_labs || jsonb_build_object(
      v_row ->> 'id',
      jsonb_build_object(
        'released', v_row -> 'availableAtStart',
        'value', v_row -> 'value',
        'flag', v_row -> 'flag'
      )
    );
  end loop;
  return jsonb_build_object(
    -- SIMULATION_ENGINE_VERSION = 1 (spec AY — lockstep with types.ts).
    'engineVersion', 1,
    'caseId', p_def ->> 'caseId',
    'caseVersion', p_def -> 'caseVersion',
    'phase', p_def ->> 'initialPhase',
    'timeMinutes', 0,
    'deteriorationLevel', 0,
    'vitals', p_def -> 'initialVitals',
    'observedVitals', null,
    'findings', v_findings,
    'labs', v_labs,
    'safetyFlags', '[]'::jsonb,
    'statements', '[]'::jsonb,
    'actionLog', '[]'::jsonb,
    'scheduled', '[]'::jsonb,
    'firedRules', '[]'::jsonb,
    'completed', null
  );
end;
$$;

-- One student action — mirrors applyAction() EXACTLY, including processing
-- order (spec D/E/G/H; see engine.ts header):
--   reject → advance time → due schedules → background rules → log +
--   classify → action semantics → action rules → background rules.
-- Returns {"state":…, "events":[…], "rejected": text|null}.
create or replace function public.sim_apply_action(
  p_def jsonb,
  p_state jsonb,
  p_submitted jsonb
)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_action jsonb;
  v_prompt_id text;
  v_ctx jsonb;
  v_state jsonb;
  v_at numeric;
  v_classification text;
  v_seq integer;
  v_system text;
  v_finding jsonb;
  v_entry jsonb;
  v_present_count integer;
  v_prompt jsonb;
  v_gated boolean;
  v_rule jsonb;
begin
  if (p_state -> 'completed') <> 'null'::jsonb then
    return jsonb_build_object(
      'state', p_state, 'events', '[]'::jsonb, 'rejected', 'simulation_completed'
    );
  end if;
  select a into v_action
  from jsonb_array_elements(p_def -> 'actions') a
  where a ->> 'id' = p_submitted ->> 'actionId';
  if v_action is null then
    return jsonb_build_object(
      'state', p_state, 'events', '[]'::jsonb, 'rejected', 'unknown_action'
    );
  end if;
  if coalesce((v_action ->> 'promptRequired')::boolean, false) then
    v_prompt_id := p_submitted -> 'params' ->> 'promptId';
    if v_prompt_id is null then
      return jsonb_build_object(
        'state', p_state, 'events', '[]'::jsonb, 'rejected', 'missing_prompt_param'
      );
    end if;
    if not exists (
      select 1 from jsonb_array_elements(p_def -> 'dialogue') d
      where d ->> 'id' = v_prompt_id
    ) then
      return jsonb_build_object(
        'state', p_state, 'events', '[]'::jsonb, 'rejected', 'unknown_prompt'
      );
    end if;
  end if;

  v_ctx := jsonb_build_object(
    'state', p_state, 'events', '[]'::jsonb, 'phases_entered', '[]'::jsonb
  );

  -- 2. time advances first (spec H) …
  v_ctx := jsonb_set(
    v_ctx, '{state,timeMinutes}',
    to_jsonb(
      (p_state ->> 'timeMinutes')::numeric
        + greatest(0, (v_action ->> 'timeCostMinutes')::numeric)
    )
  );
  -- 3. … then whatever was already coming due happens.
  v_ctx := public.sim_fire_due_scheduled(p_def, v_ctx);
  v_ctx := public.sim_fire_background_rules(p_def, v_ctx);

  -- 4. record the action (even if the case just completed — the student did
  --    take it; but no further effects can fire).
  v_state := v_ctx -> 'state';
  v_at := (v_state ->> 'timeMinutes')::numeric;
  v_classification := coalesce(
    v_action -> 'classification' -> 'byPhase' ->> (v_state ->> 'phase'),
    v_action -> 'classification' ->> 'default'
  );
  v_seq := jsonb_array_length(v_state -> 'actionLog') + 1;
  v_ctx := jsonb_set(
    v_ctx, '{state,actionLog}',
    (v_state -> 'actionLog') || jsonb_build_array(jsonb_build_object(
      'seq', v_seq, 'actionId', v_action ->> 'id',
      'atMinutes', v_at, 'classification', v_classification
    ))
  );
  v_ctx := jsonb_set(
    v_ctx, '{events}',
    (v_ctx -> 'events') || jsonb_build_array(
      jsonb_build_object(
        'type', 'action_accepted', 'actionId', v_action ->> 'id',
        'label', v_action ->> 'label', 'atMinutes', v_at, 'visible', true
      ),
      jsonb_build_object(
        'type', 'action_classified', 'actionId', v_action ->> 'id',
        'classification', v_classification, 'atMinutes', v_at, 'visible', false
      )
    )
  );

  if (v_ctx -> 'state' -> 'completed') = 'null'::jsonb then
    -- Action semantics — mirrors applyActionSemantics() (spec M/N/AG).
    v_state := v_ctx -> 'state';

    if coalesce((v_action ->> 'observesVitals')::boolean, false) then
      v_ctx := jsonb_set(v_ctx, '{state,observedVitals}', jsonb_build_object(
        'vitals', v_state -> 'vitals', 'atMinutes', v_at
      ));
      v_ctx := jsonb_set(
        v_ctx, '{events}',
        (v_ctx -> 'events') || jsonb_build_array(jsonb_build_object(
          'type', 'vitals_observed', 'vitals', v_state -> 'vitals',
          'atMinutes', v_at, 'visible', true
        ))
      );
    end if;

    if jsonb_typeof(v_action -> 'revealsSystems') = 'array'
       and jsonb_array_length(v_action -> 'revealsSystems') > 0 then
      for v_system in
        select value #>> '{}' from jsonb_array_elements(v_action -> 'revealsSystems')
      loop
        v_present_count := 0;
        for v_finding in
          select f from jsonb_array_elements(p_def -> 'findings')
            with ordinality as t(f, ord)
          where f ->> 'system' = v_system
          order by ord
        loop
          v_entry := v_ctx -> 'state' -> 'findings' -> (v_finding ->> 'id');
          if v_entry is null or not (v_entry ->> 'present')::boolean then
            continue;
          end if;
          v_present_count := v_present_count + 1;
          if not (v_entry ->> 'revealed')::boolean then
            v_ctx := jsonb_set(
              v_ctx, array['state', 'findings', v_finding ->> 'id', 'revealed'],
              'true'::jsonb
            );
            v_ctx := jsonb_set(
              v_ctx, '{events}',
              (v_ctx -> 'events') || jsonb_build_array(jsonb_build_object(
                'type', 'finding_revealed', 'findingId', v_finding ->> 'id',
                'system', v_system, 'text', v_finding ->> 'text',
                'atMinutes', v_at, 'visible', true
              ))
            );
          end if;
        end loop;
        if v_present_count = 0 then
          v_ctx := jsonb_set(
            v_ctx, '{events}',
            (v_ctx -> 'events') || jsonb_build_array(jsonb_build_object(
              'type', 'no_new_findings', 'system', v_system,
              'atMinutes', v_at, 'visible', true
            ))
          );
        end if;
      end loop;
    end if;

    if v_action ->> 'type' = 'ask_patient' then
      select d into v_prompt
      from jsonb_array_elements(p_def -> 'dialogue') d
      where d ->> 'id' = p_submitted -> 'params' ->> 'promptId';
      if v_prompt is not null then
        v_gated := (v_prompt ->> 'requiresFindingRevealed') is not null
          and coalesce(
            (v_ctx -> 'state' -> 'findings'
              -> (v_prompt ->> 'requiresFindingRevealed') ->> 'revealed')::boolean,
            false
          ) is not true;
        v_ctx := jsonb_set(
          v_ctx, '{events}',
          (v_ctx -> 'events') || jsonb_build_array(jsonb_build_object(
            'type', 'dialogue', 'question', v_prompt ->> 'question',
            'response', case
              when v_gated then coalesce(
                v_prompt ->> 'gatedResponse',
                'I’m not sure — can you check me first?'
              )
              else v_prompt ->> 'response'
            end,
            'atMinutes', v_at, 'visible', true
          ))
        );
      end if;
    end if;

    -- 5. action-triggered rules, in case order.
    for v_rule in
      select r from jsonb_array_elements(p_def -> 'rules')
        with ordinality as t(r, ord)
      order by ord
    loop
      if (v_ctx -> 'state' -> 'completed') <> 'null'::jsonb then
        exit;
      end if;
      if v_rule -> 'trigger' ->> 'kind' = 'action'
         and v_rule -> 'trigger' ->> 'actionId' = v_action ->> 'id' then
        v_ctx := public.sim_fire_rule(p_def, v_ctx, v_rule);
      end if;
    end loop;

    -- 6. background rules to a fixed point.
    v_ctx := public.sim_fire_background_rules(p_def, v_ctx);
  end if;

  return jsonb_build_object(
    'state', v_ctx -> 'state', 'events', v_ctx -> 'events', 'rejected', null
  );
end;
$$;

-- Redacted student-facing view — mirrors clientView() (spec N/AJ). The ONLY
-- simulation payload a student's device may receive mid-session: no true
-- vitals, no unrevealed findings, no phase/deterioration/flags/rule state,
-- no classifications, no key-cue markers.
create or replace function public.sim_client_view(p_def jsonb, p_state jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_revealed jsonb;
  v_labs jsonb;
  v_statements jsonb;
  v_actions jsonb;
  v_prompts jsonb;
  v_completed jsonb := 'null'::jsonb;
  v_outcome jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f ->> 'id', 'system', f ->> 'system', 'text', f ->> 'text'
  ) order by ord), '[]'::jsonb) into v_revealed
  from jsonb_array_elements(p_def -> 'findings') with ordinality as t(f, ord)
  where coalesce(
    (p_state -> 'findings' -> (f ->> 'id') ->> 'revealed')::boolean, false
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l ->> 'id', 'name', l ->> 'name',
    'value', p_state -> 'labs' -> (l ->> 'id') -> 'value',
    'unit', l ->> 'unit',
    'flag', p_state -> 'labs' -> (l ->> 'id') ->> 'flag'
  ) order by ord), '[]'::jsonb) into v_labs
  from jsonb_array_elements(p_def -> 'labs') with ordinality as t(l, ord)
  where coalesce(
    (p_state -> 'labs' -> (l ->> 'id') ->> 'released')::boolean, false
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'text', (
      select st ->> 'text' from jsonb_array_elements(p_def -> 'statements') st
      where st ->> 'id' = s ->> 'statementId'
    ),
    'atMinutes', s -> 'atMinutes'
  ) order by ord), '[]'::jsonb) into v_statements
  from jsonb_array_elements(p_state -> 'statements') with ordinality as t(s, ord)
  where exists (
    select 1 from jsonb_array_elements(p_def -> 'statements') st
    where st ->> 'id' = s ->> 'statementId'
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a ->> 'id', 'type', a ->> 'type', 'label', a ->> 'label',
    'timeCostMinutes', a -> 'timeCostMinutes',
    'promptRequired', coalesce((a ->> 'promptRequired')::boolean, false)
  ) order by ord), '[]'::jsonb) into v_actions
  from jsonb_array_elements(p_def -> 'actions') with ordinality as t(a, ord);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d ->> 'id', 'question', d ->> 'question'
  ) order by ord), '[]'::jsonb) into v_prompts
  from jsonb_array_elements(p_def -> 'dialogue') with ordinality as t(d, ord);

  if (p_state -> 'completed') <> 'null'::jsonb then
    select o into v_outcome
    from jsonb_array_elements(p_def -> 'outcomes') o
    where o ->> 'id' = p_state -> 'completed' ->> 'outcomeId';
    v_completed := jsonb_build_object(
      'outcomeId', p_state -> 'completed' ->> 'outcomeId',
      'label', coalesce(v_outcome ->> 'label', p_state -> 'completed' ->> 'outcomeId'),
      'kind', coalesce(v_outcome ->> 'kind', 'timeout'),
      'atMinutes', p_state -> 'completed' -> 'atMinutes'
    );
  end if;

  return jsonb_build_object(
    'caseId', p_def ->> 'caseId',
    'title', p_def ->> 'title',
    'description', p_def ->> 'description',
    'difficulty', p_def ->> 'difficulty',
    'scenarioType', p_def ->> 'scenarioType',
    'estimatedDurationMinutes', p_def -> 'estimatedDurationMinutes',
    'caseVersion', p_def -> 'caseVersion',
    'engineVersion', p_def -> 'engineVersion',
    'patient', p_def -> 'patient',
    'medicationOrders', p_def -> 'medicationOrders',
    'timeMinutes', p_state -> 'timeMinutes',
    'observedVitals', p_state -> 'observedVitals',
    'revealedFindings', v_revealed,
    'releasedLabs', v_labs,
    'statements', v_statements,
    'availableActions', v_actions,
    'dialoguePrompts', v_prompts,
    'completed', v_completed
  );
end;
$$;

-- Deterministic session scoring — mirrors scoreSession() (spec S; algorithm
-- version 1, SIMULATION_SCORE_VERSION lockstep with score.ts).
create or replace function public.sim_score_session(
  p_def jsonb,
  p_state jsonb,
  p_events jsonb
)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_dimensions jsonb := jsonb_build_object(
    'recognize_cues', jsonb_build_object('earned', 0, 'possible', 0),
    'analyze_cues', jsonb_build_object('earned', 0, 'possible', 0),
    'prioritize_hypotheses', jsonb_build_object('earned', 0, 'possible', 0),
    'generate_solutions', jsonb_build_object('earned', 0, 'possible', 0),
    'take_action', jsonb_build_object('earned', 0, 'possible', 0),
    'evaluate_outcomes', jsonb_build_object('earned', 0, 'possible', 0)
  );
  v_entries jsonb := '[]'::jsonb;
  v_earned numeric := 0;
  v_possible numeric := 0;
  v_entry jsonb;
  v_crit jsonb;
  v_kind text;
  v_met boolean;
  v_points numeric;
  v_dim text;
  v_by numeric;
  v_at numeric;
  v_target jsonb;
  v_missed jsonb;
  v_unsafe jsonb;
begin
  for v_entry in
    select e from jsonb_array_elements(p_def -> 'scoring')
      with ordinality as t(e, ord)
    order by ord
  loop
    v_crit := v_entry -> 'criterion';
    v_kind := v_crit ->> 'kind';
    v_by := (v_crit ->> 'byMinutes')::numeric;

    if v_kind = 'critical_action_done' then
      v_met := exists (
        select 1 from jsonb_array_elements(p_state -> 'actionLog') a
        where a ->> 'actionId' = v_crit ->> 'actionId'
          and (v_by is null or (a ->> 'atMinutes')::numeric <= v_by)
      );
    elsif v_kind = 'any_action_done' then
      v_met := exists (
        select 1 from jsonb_array_elements(p_state -> 'actionLog') a
        where (v_crit -> 'actionIds') ? (a ->> 'actionId')
          and (v_by is null or (a ->> 'atMinutes')::numeric <= v_by)
      );
    elsif v_kind = 'cue_revealed' then
      select min((e ->> 'atMinutes')::numeric) into v_at
      from jsonb_array_elements(p_events) e
      where e ->> 'type' = 'finding_revealed'
        and e ->> 'findingId' = v_crit ->> 'findingId';
      v_met := v_at is not null and (v_by is null or v_at <= v_by);
    elsif v_kind = 'vitals_obtained' then
      v_met := exists (
        select 1 from jsonb_array_elements(p_state -> 'actionLog') a
        where (v_by is null or (a ->> 'atMinutes')::numeric <= v_by)
          and exists (
            select 1 from jsonb_array_elements(p_def -> 'actions') act
            where act ->> 'id' = a ->> 'actionId'
              and coalesce((act ->> 'observesVitals')::boolean, false)
          )
      );
    elsif v_kind = 'no_unsafe_actions' then
      v_met := not exists (
        select 1 from jsonb_array_elements(p_state -> 'actionLog') a
        where a ->> 'classification' in ('unsafe', 'contraindicated')
      );
    elsif v_kind = 'action_not_done' then
      v_met := not exists (
        select 1 from jsonb_array_elements(p_state -> 'actionLog') a
        where a ->> 'actionId' = v_crit ->> 'actionId'
      );
    elsif v_kind = 'reassessed_after' then
      -- FIRST log entry for the target action (mirrors Array.find).
      select a into v_target
      from jsonb_array_elements(p_state -> 'actionLog')
        with ordinality as t(a, ord)
      where a ->> 'actionId' = v_crit ->> 'actionId'
      order by ord
      limit 1;
      if v_target is null then
        v_met := false;
      else
        v_met := exists (
          select 1 from jsonb_array_elements(p_state -> 'actionLog') a
          where (a ->> 'atMinutes')::numeric > (v_target ->> 'atMinutes')::numeric
            and (a ->> 'atMinutes')::numeric
              <= (v_target ->> 'atMinutes')::numeric
                + (v_crit ->> 'withinMinutes')::numeric
            and exists (
              select 1 from jsonb_array_elements(p_def -> 'actions') act
              where act ->> 'id' = a ->> 'actionId'
                and (
                  coalesce((act ->> 'observesVitals')::boolean, false)
                  or act ->> 'type' in ('assess', 'reassess')
                )
            )
        );
      end if;
    elsif v_kind = 'outcome_is' then
      v_met := (p_state -> 'completed') <> 'null'::jsonb
        and p_state -> 'completed' ->> 'outcomeId' = v_crit ->> 'outcomeId';
    else
      raise exception 'unknown scoring criterion %', v_kind;
    end if;

    v_points := (v_entry ->> 'points')::numeric;
    v_dim := v_entry ->> 'dimension';
    v_dimensions := jsonb_set(
      v_dimensions, array[v_dim, 'possible'],
      to_jsonb((v_dimensions -> v_dim ->> 'possible')::numeric + v_points)
    );
    v_possible := v_possible + v_points;
    if v_met then
      v_dimensions := jsonb_set(
        v_dimensions, array[v_dim, 'earned'],
        to_jsonb((v_dimensions -> v_dim ->> 'earned')::numeric + v_points)
      );
      v_earned := v_earned + v_points;
    end if;
    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'id', v_entry ->> 'id', 'dimension', v_dim, 'points', v_entry -> 'points',
      'earned', v_met, 'label', v_entry ->> 'label'
    ));
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'criticalId', c ->> 'id', 'label', c ->> 'label'
  ) order by ord), '[]'::jsonb) into v_missed
  from jsonb_array_elements(p_def -> 'criticalActions')
    with ordinality as t(c, ord)
  where not exists (
    select 1 from jsonb_array_elements(p_state -> 'actionLog') a
    where (c -> 'anyOfActionIds') ? (a ->> 'actionId')
      and (
        (c ->> 'byMinutes') is null
        or (a ->> 'atMinutes')::numeric <= (c ->> 'byMinutes')::numeric
      )
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'actionId', a ->> 'actionId', 'classification', a ->> 'classification'
  ) order by ord), '[]'::jsonb) into v_unsafe
  from jsonb_array_elements(p_state -> 'actionLog')
    with ordinality as t(a, ord)
  where a ->> 'classification' in ('unsafe', 'contraindicated');

  return jsonb_build_object(
    'algorithmVersion', 1,
    'dimensions', v_dimensions,
    'entries', v_entries,
    'earned', v_earned,
    'possible', v_possible,
    'missedCriticalActions', v_missed,
    'unsafeActionsTaken', v_unsafe
  );
end;
$$;

-- Internal helpers: clients may never call the interpreter directly.
revoke all on function public.sim_clamp(text, numeric, numeric, numeric)
  from public, anon, authenticated;
revoke all on function public.sim_condition_met(jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.sim_apply_effect(jsonb, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.sim_fire_rule(jsonb, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.sim_fire_due_scheduled(jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.sim_fire_background_rules(jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.sim_start_state(jsonb)
  from public, anon, authenticated;
revoke all on function public.sim_apply_action(jsonb, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.sim_client_view(jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.sim_score_session(jsonb, jsonb, jsonb)
  from public, anon, authenticated;

-- ===========================================================================
-- RPCs — the client's ONLY interface to simulations (spec V/W/X/Y/Z/AW).
-- ===========================================================================

-- Start (or resume) a simulation session (spec V/X). Starting a case the
-- student already has an ACTIVE session for RESUMES that session — server-
-- side, from the authoritative state (spec X); it never re-creates or resets.
create or replace function public.start_simulation(
  p_course_id uuid,
  p_case_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_case public.simulation_cases%rowtype;
  v_session public.simulation_sessions%rowtype;
  v_state jsonb;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if not exists (
    select 1 from public.courses c
    where c.id = p_course_id and c.user_id = v_user_id
  ) then
    raise exception 'course not found';
  end if;

  select * into v_case from public.simulation_cases
  where case_key = p_case_key and status = 'active';
  if v_case.id is null then
    raise exception 'simulation case not found';
  end if;
  -- Spec AY: refuse to run a definition authored for different semantics.
  if v_case.engine_version <> 1 then
    raise exception 'simulation engine version mismatch';
  end if;

  select * into v_session from public.simulation_sessions
  where user_id = v_user_id and course_id = p_course_id
    and case_id = v_case.id and status = 'active'
  order by started_at desc
  limit 1;
  if v_session.id is not null then
    return jsonb_build_object(
      'session_id', v_session.id,
      'resumed', true,
      'status', v_session.status,
      'view', public.sim_client_view(v_case.definition, v_session.state)
    );
  end if;

  v_state := public.sim_start_state(v_case.definition);
  insert into public.simulation_sessions
    (user_id, course_id, case_id, case_version, engine_version, state)
  values
    (v_user_id, p_course_id, v_case.id, v_case.case_version,
     v_case.engine_version, v_state)
  returning * into v_session;

  return jsonb_build_object(
    'session_id', v_session.id,
    'resumed', false,
    'status', v_session.status,
    'view', public.sim_client_view(v_case.definition, v_state)
  );
end;
$$;

-- Submit one action (spec D/E/W/Y/Z/BC). One transaction: interpret, append
-- history, persist state, and — on completion — score + mastery evidence,
-- all together or not at all. FOR UPDATE serializes concurrent submissions;
-- a repeated idempotency key returns the ORIGINAL stored result (spec Y:
-- double-tapping "Administer medication" can never administer twice).
create or replace function public.simulation_act(
  p_session_id uuid,
  p_action_id text,
  p_params jsonb default '{}'::jsonb,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_session public.simulation_sessions%rowtype;
  v_def jsonb;
  v_prior jsonb;
  v_result jsonb;
  v_apply jsonb;
  v_rejected text;
  v_new_state jsonb;
  v_events jsonb;
  v_visible jsonb;
  v_seq integer;
  v_all_events jsonb;
  v_score jsonb;
  v_now timestamptz := now();
  -- Mastery constants (algorithm version 1) — mirror 0008 /
  -- packages/mastery/src/config.ts. MUST change in lockstep (ADR-0022).
  v_algorithm_version constant integer := 1;
  v_intervals constant integer[] := array[24, 72, 168, 336, 720];
  v_mapping jsonb;
  v_dim text;
  v_map_earned numeric;
  v_map_possible numeric;
  v_is_correct boolean;
  v_concept_id uuid;
  v_mastery public.concept_mastery%rowtype;
  v_diff_w numeric;
  v_cog_w numeric;
  v_weight numeric;
  v_m_before numeric;
  v_m_after numeric;
  v_severity numeric;
  v_stage integer;
  v_next_review timestamptz;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  -- Lock the session row: concurrent submissions serialize here (spec Z).
  select * into v_session from public.simulation_sessions
  where id = p_session_id and user_id = v_user_id
  for update;
  if v_session.id is null then
    raise exception 'session not found';
  end if;
  if v_session.status = 'abandoned' then
    raise exception 'session was abandoned';
  end if;

  -- Idempotent retry (spec Y): same key → same stored result, no re-run.
  if p_idempotency_key is not null then
    select result into v_prior from public.simulation_actions
    where session_id = v_session.id and idempotency_key = p_idempotency_key;
    if v_prior is not null then
      return v_prior;
    end if;
  end if;

  select definition into v_def from public.simulation_cases
  where id = v_session.case_id;

  v_apply := public.sim_apply_action(
    v_def, v_session.state,
    jsonb_build_object('actionId', p_action_id, 'params', coalesce(p_params, '{}'::jsonb))
  );
  v_rejected := v_apply ->> 'rejected';
  v_new_state := v_apply -> 'state';
  v_events := v_apply -> 'events';

  select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) into v_visible
  from jsonb_array_elements(v_events) with ordinality as t(e, ord)
  where (e ->> 'visible')::boolean;

  select coalesce(max(seq), 0) + 1 into v_seq
  from public.simulation_actions where session_id = v_session.id;

  if v_rejected is not null then
    -- Rejections are audited too (spec W) but change nothing (spec BC).
    v_result := jsonb_build_object(
      'rejected', v_rejected,
      'events', '[]'::jsonb,
      'view', public.sim_client_view(v_def, v_session.state)
    );
    insert into public.simulation_actions
      (session_id, seq, action_id, params, idempotency_key, rejected,
       sim_time_minutes, events, result)
    values
      (v_session.id, v_seq, p_action_id, coalesce(p_params, '{}'::jsonb),
       p_idempotency_key, v_rejected,
       (v_session.state ->> 'timeMinutes')::integer, '[]'::jsonb, v_result);
    return v_result;
  end if;

  update public.simulation_sessions
  set state = v_new_state
  where id = v_session.id;

  if (v_new_state -> 'completed') <> 'null'::jsonb then
    -- Completion (spec AP/S/T/U): outcome, score, and mastery evidence in
    -- THIS same transaction (spec BC).
    select coalesce(jsonb_agg(e order by a_seq, e_ord), '[]'::jsonb)
      into v_all_events
    from (
      select a.seq as a_seq, t.e, t.ord as e_ord
      from public.simulation_actions a,
           jsonb_array_elements(a.events) with ordinality as t(e, ord)
      where a.session_id = v_session.id and a.rejected is null
      union all
      select v_seq, t.e, t.ord
      from jsonb_array_elements(v_events) with ordinality as t(e, ord)
    ) all_ev(a_seq, e, e_ord);

    v_score := public.sim_score_session(v_def, v_new_state, v_all_events);

    update public.simulation_sessions
    set status = 'completed',
        outcome_id = v_new_state -> 'completed' ->> 'outcomeId',
        score = v_score,
        completed_at = v_now
    where id = v_session.id;

    -- One mastery model (spec T/U): normalize the score into bounded
    -- evidence per mapped concept using the SAME v1 constants as question
    -- attempts (confidence is null → neutral weight). Concepts that do not
    -- exist in this course yield NO evidence — silence over invention.
    for v_mapping in
      select m from jsonb_array_elements(v_def -> 'conceptMappings')
        with ordinality as t(m, ord)
      order by ord
    loop
      v_map_earned := 0;
      v_map_possible := 0;
      for v_dim in
        select value #>> '{}' from jsonb_array_elements(v_mapping -> 'dimensions')
      loop
        v_map_earned := v_map_earned
          + (v_score -> 'dimensions' -> v_dim ->> 'earned')::numeric;
        v_map_possible := v_map_possible
          + (v_score -> 'dimensions' -> v_dim ->> 'possible')::numeric;
      end loop;
      if v_map_possible <= 0 then
        continue;
      end if;
      -- EVIDENCE_CORRECT_THRESHOLD = 0.65 (evidence.ts, lockstep).
      v_is_correct := v_map_earned / v_map_possible >= 0.65;

      select id into v_concept_id from public.concepts
      where course_id = v_session.course_id
        and normalized_key = v_mapping ->> 'conceptKey'
        and status = 'active';
      if v_concept_id is null then
        select concept_id into v_concept_id from public.concept_aliases
        where course_id = v_session.course_id
          and normalized_alias = v_mapping ->> 'conceptKey';
      end if;
      if v_concept_id is null then
        continue;
      end if;

      -- Evidence weight (mirror of 0008 with p_confidence = null).
      if v_is_correct then
        v_diff_w := case v_mapping ->> 'difficulty'
          when 'easy' then 0.8 when 'moderate' then 1.0 else 1.25 end;
        v_cog_w := case v_mapping ->> 'cognitiveLevel'
          when 'recall' then 0.85
          when 'understanding' then 0.95
          when 'application' then 1.1
          when 'analysis' then 1.2
          else 1.25 end;
      else
        v_diff_w := case v_mapping ->> 'difficulty'
          when 'easy' then 1.25 when 'moderate' then 1.0 else 0.8 end;
        v_cog_w := 1.0;
      end if;
      v_weight := round(least(2.0, greatest(0.25, v_diff_w * v_cog_w * 1.0 * 1.0)), 6);

      select * into v_mastery from public.concept_mastery
      where user_id = v_user_id and course_id = v_session.course_id
        and concept_id = v_concept_id
      for update;
      if v_mastery.user_id is null then
        insert into public.concept_mastery (user_id, course_id, concept_id)
        values (v_user_id, v_session.course_id, v_concept_id)
        on conflict (user_id, course_id, concept_id) do nothing;
        select * into v_mastery from public.concept_mastery
        where user_id = v_user_id and course_id = v_session.course_id
          and concept_id = v_concept_id
        for update;
      end if;

      v_m_before := least(1, greatest(0, v_mastery.mastery));
      if v_is_correct then
        v_m_after := v_m_before + least(0.3 * v_weight * (1 - v_m_before), 0.25);
      else
        v_m_after := v_m_before - least(0.4 * v_weight * greatest(v_m_before, 0.35), 0.3);
      end if;
      v_m_after := round(least(1, greatest(0, v_m_after)), 6);

      if v_is_correct then
        v_severity := round(v_mastery.misconception_severity * 0.5, 6);
      else
        -- Confidence is null for simulations → the default 0.10 increment.
        v_severity := round(least(1, greatest(0, v_mastery.misconception_severity + 0.10)), 6);
      end if;

      if not v_is_correct then
        v_stage := 0;
      else
        v_stage := least(v_mastery.review_stage + 1, 4);
      end if;
      v_next_review := v_now + make_interval(hours => v_intervals[v_stage + 1]);

      update public.concept_mastery
      set mastery = v_m_after,
          attempts_count = v_mastery.attempts_count + 1,
          correct_count = v_mastery.correct_count
            + case when v_is_correct then 1 else 0 end,
          misconception_severity = v_severity,
          review_stage = v_stage,
          last_attempt_at = v_now,
          next_review_at = v_next_review,
          algorithm_version = v_algorithm_version
      where user_id = v_user_id and course_id = v_session.course_id
        and concept_id = v_concept_id;

      insert into public.mastery_events
        (attempt_id, simulation_session_id, user_id, course_id, concept_id,
         is_correct, evidence_weight, mastery_before, mastery_after,
         misconception_severity_after, review_stage_after, next_review_at,
         algorithm_version)
      values
        (null, v_session.id, v_user_id, v_session.course_id, v_concept_id,
         v_is_correct, v_weight, v_m_before, v_m_after, v_severity, v_stage,
         v_next_review, v_algorithm_version);
    end loop;
  end if;

  v_result := jsonb_build_object(
    'rejected', null,
    'events', v_visible,
    'view', public.sim_client_view(v_def, v_new_state)
  );

  insert into public.simulation_actions
    (session_id, seq, action_id, params, idempotency_key, rejected,
     sim_time_minutes, events, result)
  values
    (v_session.id, v_seq, p_action_id, coalesce(p_params, '{}'::jsonb),
     p_idempotency_key, null,
     (v_new_state ->> 'timeMinutes')::integer, v_events, v_result);

  return v_result;
end;
$$;

-- Server-side resume (spec X): rebuild the redacted view from the
-- authoritative state. Never trusts anything client-side.
create or replace function public.get_simulation_view(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_session public.simulation_sessions%rowtype;
  v_def jsonb;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  select * into v_session from public.simulation_sessions
  where id = p_session_id and user_id = v_user_id;
  if v_session.id is null then
    raise exception 'session not found';
  end if;
  select definition into v_def from public.simulation_cases
  where id = v_session.case_id;
  return jsonb_build_object(
    'session_id', v_session.id,
    'status', v_session.status,
    'started_at', v_session.started_at,
    'completed_at', v_session.completed_at,
    'view', public.sim_client_view(v_def, v_session.state)
  );
end;
$$;

-- Abandon an active session (spec V). No score, no mastery evidence — an
-- incomplete run is honestly recorded as incomplete, never invented signal.
create or replace function public.abandon_simulation(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_session public.simulation_sessions%rowtype;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  select * into v_session from public.simulation_sessions
  where id = p_session_id and user_id = v_user_id
  for update;
  if v_session.id is null then
    raise exception 'session not found';
  end if;
  if v_session.status <> 'active' then
    raise exception 'session is not active';
  end if;
  update public.simulation_sessions
  set status = 'abandoned'
  where id = v_session.id;
  return jsonb_build_object('session_id', v_session.id, 'status', 'abandoned');
end;
$$;

-- Debrief (spec AQ/AR/AS): released ONLY after completion. Now — and only
-- now — the hidden record opens: classifications, rule descriptions, vital
-- changes, the full timeline, the deterministic score, and the evidence
-- that fed mastery.
create or replace function public.get_simulation_debrief(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_session public.simulation_sessions%rowtype;
  v_case public.simulation_cases%rowtype;
  v_def jsonb;
  v_outcome jsonb;
  v_timeline jsonb;
  v_key_cues jsonb;
  v_evidence jsonb;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  select * into v_session from public.simulation_sessions
  where id = p_session_id and user_id = v_user_id;
  if v_session.id is null then
    raise exception 'session not found';
  end if;
  if v_session.status <> 'completed' then
    raise exception 'session is not completed';
  end if;
  select * into v_case from public.simulation_cases where id = v_session.case_id;
  v_def := v_case.definition;

  select o into v_outcome
  from jsonb_array_elements(v_def -> 'outcomes') o
  where o ->> 'id' = v_session.outcome_id;

  -- Per-submission timeline (spec AR): every event — hidden ones included —
  -- with its rule description (spec AS explanatory metadata).
  select coalesce(jsonb_agg(jsonb_build_object(
    'seq', a.seq,
    'actionId', a.action_id,
    'label', (
      select act ->> 'label' from jsonb_array_elements(v_def -> 'actions') act
      where act ->> 'id' = a.action_id
    ),
    'params', a.params,
    'rejected', a.rejected,
    'atMinutes', a.sim_time_minutes,
    'events', a.events
  ) order by a.seq), '[]'::jsonb) into v_timeline
  from public.simulation_actions a
  where a.session_id = v_session.id;

  -- Key cues (spec AQ): which mattered, which were found, which were missed.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f ->> 'id', 'system', f ->> 'system', 'text', f ->> 'text',
    'revealed', coalesce(
      (v_session.state -> 'findings' -> (f ->> 'id') ->> 'revealed')::boolean,
      false
    )
  ) order by ord), '[]'::jsonb) into v_key_cues
  from jsonb_array_elements(v_def -> 'findings') with ordinality as t(f, ord)
  where (f ->> 'keyCue')::boolean;

  select coalesce(jsonb_agg(jsonb_build_object(
    'conceptId', me.concept_id,
    'conceptName', c.canonical_name,
    'isCorrect', me.is_correct,
    'masteryBefore', me.mastery_before,
    'masteryAfter', me.mastery_after
  ) order by c.canonical_name), '[]'::jsonb) into v_evidence
  from public.mastery_events me
  join public.concepts c on c.id = me.concept_id
  where me.simulation_session_id = v_session.id;

  return jsonb_build_object(
    'session_id', v_session.id,
    'case', jsonb_build_object(
      'caseKey', v_case.case_key,
      'title', v_case.title,
      'caseVersion', v_session.case_version,
      'engineVersion', v_session.engine_version,
      'difficulty', v_case.difficulty,
      'scenarioType', v_case.scenario_type
    ),
    'outcome', jsonb_build_object(
      'outcomeId', v_session.outcome_id,
      'label', coalesce(v_outcome ->> 'label', v_session.outcome_id),
      'kind', coalesce(v_outcome ->> 'kind', 'timeout'),
      'summary', coalesce(v_outcome ->> 'summary', ''),
      'atMinutes', v_session.state -> 'completed' -> 'atMinutes'
    ),
    'durationMinutes', v_session.state -> 'timeMinutes',
    'score', v_session.score,
    'timeline', v_timeline,
    'keyCues', v_key_cues,
    'missedCriticalActions', v_session.score -> 'missedCriticalActions',
    'unsafeActionsTaken', v_session.score -> 'unsafeActionsTaken',
    'evidence', v_evidence,
    'recommendations', v_def -> 'debriefRecommendations'
  );
end;
$$;

-- Only signed-in users may call the RPCs; anonymous may not (spec AW).
revoke all on function public.start_simulation(uuid, text) from public, anon;
grant execute on function public.start_simulation(uuid, text) to authenticated;
revoke all on function public.simulation_act(uuid, text, jsonb, text) from public, anon;
grant execute on function public.simulation_act(uuid, text, jsonb, text) to authenticated;
revoke all on function public.get_simulation_view(uuid) from public, anon;
grant execute on function public.get_simulation_view(uuid) to authenticated;
revoke all on function public.abandon_simulation(uuid) from public, anon;
grant execute on function public.abandon_simulation(uuid) to authenticated;
revoke all on function public.get_simulation_debrief(uuid) from public, anon;
grant execute on function public.get_simulation_debrief(uuid) to authenticated;
