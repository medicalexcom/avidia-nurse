-- M8: adaptive mastery engine and intelligent study scheduler
-- (spec A/B/C/D/E/F/G/H/I/J/K/R/Z/AA/AC/AD; Playbook §7 concept_mastery,
--  §12 mastery engine, §15 step 8 "persist attempt and mastery update
--  transactionally"; ADR-0022 mastery algorithm, ADR-0023 spaced repetition,
--  ADR-0024 adaptive priority).
--
-- Model:
--   * concept_mastery   ONE aggregate row per user × course × concept
--                       (spec A/AM: persistent state, no full-history
--                       recompute per answer)
--   * mastery_events    append-only audit trail — every attempt that moved
--                       mastery is traceable to its exact update (spec Z);
--                       unique(attempt_id) makes the update idempotent
--                       (spec AC)
--   * submit_question_attempt (REPLACED) — scoring AND the mastery update
--                       happen in ONE transaction: an attempt can never be
--                       recorded without its mastery update, and a mastery
--                       update can never exist without its attempt.
--
-- THE ALGORITHM IS DETERMINISTIC SQL, mirrored constant-for-constant by
-- `@avidia/mastery` (packages/mastery/src/config.ts, version 1). The LLM is
-- NOT the mastery engine — no AI provider is ever consulted here (core
-- principle). Changing any constant below requires bumping
-- v_algorithm_version AND the TS mirror together; contract tests pin both.
--
-- Deviation from the Playbook §7 sketch (same reasoning as ADR-0014):
-- concepts are course-scoped in this repo, so concept_mastery carries
-- course_id and the primary key is (user_id, course_id, concept_id).

-- ---------------------------------------------------------------------------
-- adaptive sessions (spec V): a new session_type, same table and lifecycle
-- ---------------------------------------------------------------------------

alter table public.study_sessions
  drop constraint study_sessions_session_type_check;
alter table public.study_sessions
  add constraint study_sessions_session_type_check
    check (session_type in ('practice', 'adaptive'));

-- ---------------------------------------------------------------------------
-- concept_mastery (spec A/B/AM)
-- ---------------------------------------------------------------------------

create table public.concept_mastery (
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null references public.courses (id) on delete cascade,
  concept_id uuid not null references public.concepts (id) on delete cascade,
  -- Normalized mastery evidence (spec B). INTERNAL precision; students only
  -- ever see the coarse states derived in @avidia/mastery (spec AG).
  mastery numeric not null default 0 check (mastery >= 0 and mastery <= 1),
  attempts_count integer not null default 0 check (attempts_count >= 0),
  correct_count integer not null default 0 check (correct_count >= 0),
  -- Accumulated confident-error signal (spec R); a flag for emphasis, never
  -- an AI diagnosis.
  misconception_severity numeric not null default 0
    check (misconception_severity >= 0 and misconception_severity <= 1),
  -- Spaced-review stage: index into the interval ladder (spec K).
  review_stage integer not null default 0 check (review_stage between 0 and 4),
  last_attempt_at timestamptz null,
  next_review_at timestamptz null,
  -- Which algorithm version last wrote this aggregate (spec AA).
  algorithm_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint concept_mastery_counts check (correct_count <= attempts_count),
  primary key (user_id, course_id, concept_id)
);

create index concept_mastery_course_idx on public.concept_mastery (course_id);
create index concept_mastery_next_review_idx
  on public.concept_mastery (user_id, next_review_at);

create trigger concept_mastery_set_updated_at
  before update on public.concept_mastery
  for each row execute function public.set_updated_at();

alter table public.concept_mastery enable row level security;
alter table public.concept_mastery force row level security;

-- Owners read their OWN mastery in their OWN courses; nothing else, nobody
-- else (spec AD). There is NO client write path of any kind — the only
-- writer is the SECURITY DEFINER RPC below.
create policy concept_mastery_select_own on public.concept_mastery
  for select
  using (
    concept_mastery.user_id = (select auth.uid())
    and exists (
      select 1 from public.courses c
      where c.id = concept_mastery.course_id
        and c.user_id = (select auth.uid())
    )
  );

revoke all on table public.concept_mastery from anon, authenticated;
grant select (
  user_id, course_id, concept_id, mastery, attempts_count, correct_count,
  misconception_severity, review_stage, last_attempt_at, next_review_at,
  algorithm_version, created_at, updated_at
) on table public.concept_mastery to authenticated;

-- ---------------------------------------------------------------------------
-- mastery_events (spec Z/AA/AC): auditable history of every update
-- ---------------------------------------------------------------------------

create table public.mastery_events (
  id uuid primary key default gen_random_uuid(),
  -- unique: one mastery update per attempt, ever (spec AC idempotency).
  attempt_id uuid not null unique
    references public.question_attempts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null references public.courses (id) on delete cascade,
  concept_id uuid not null references public.concepts (id) on delete cascade,
  is_correct boolean not null,
  -- The clamped combined evidence weight actually applied (spec Z: the
  -- update is reproducible from this row + the versioned algorithm).
  evidence_weight numeric not null,
  mastery_before numeric not null check (mastery_before >= 0 and mastery_before <= 1),
  mastery_after numeric not null check (mastery_after >= 0 and mastery_after <= 1),
  misconception_severity_after numeric not null
    check (misconception_severity_after >= 0 and misconception_severity_after <= 1),
  review_stage_after integer not null check (review_stage_after between 0 and 4),
  next_review_at timestamptz not null,
  algorithm_version integer not null,
  created_at timestamptz not null default now()
);

create index mastery_events_user_concept_idx
  on public.mastery_events (user_id, course_id, concept_id);

alter table public.mastery_events enable row level security;
alter table public.mastery_events force row level security;

create policy mastery_events_select_own on public.mastery_events
  for select
  using (
    mastery_events.user_id = (select auth.uid())
    and exists (
      select 1 from public.courses c
      where c.id = mastery_events.course_id
        and c.user_id = (select auth.uid())
    )
  );

revoke all on table public.mastery_events from anon, authenticated;
grant select (
  id, attempt_id, user_id, course_id, concept_id, is_correct, evidence_weight,
  mastery_before, mastery_after, misconception_severity_after,
  review_stage_after, next_review_at, algorithm_version, created_at
) on table public.mastery_events to authenticated;

-- ---------------------------------------------------------------------------
-- submit_question_attempt — REPLACED to add the transactional mastery update
-- (Playbook §15 step 8). Everything up to and including the attempt insert
-- is byte-identical in behavior to migration 0007; the mastery block and the
-- `mastery` key in the return value are the only additions (backward
-- compatible: M7 clients ignore the extra key).
-- ---------------------------------------------------------------------------

create or replace function public.submit_question_attempt(
  p_session_id uuid,
  p_question_id uuid,
  p_response jsonb,
  p_response_time_ms integer default null,
  p_confidence text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_course_id uuid;
  v_session_status text;
  v_question public.questions%rowtype;
  v_is_correct boolean;
  v_selected uuid[];
  v_correct uuid[];
  v_correct_order uuid[];
  v_value numeric;
  v_options jsonb;
  v_attempt_id uuid;
  -- Mastery update working state (algorithm version 1 — the constants below
  -- mirror packages/mastery/src/config.ts and MUST change in lockstep).
  v_algorithm_version constant integer := 1;
  v_intervals constant integer[] := array[24, 72, 168, 336, 720]; -- hours
  v_mastery public.concept_mastery%rowtype;
  v_weight numeric;
  v_diff_w numeric;
  v_cog_w numeric;
  v_conf_w numeric;
  v_m_before numeric;
  v_m_after numeric;
  v_severity numeric;
  v_stage integer;
  v_next_review timestamptz;
  v_now timestamptz := now();
  v_mastery_json jsonb := null;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  -- The session must belong to a course owned by the caller and be open.
  select s.course_id, s.status into v_course_id, v_session_status
  from public.study_sessions s
  join public.courses c on c.id = s.course_id
  where s.id = p_session_id and c.user_id = v_user_id;
  if v_course_id is null then
    raise exception 'session not found';
  end if;
  if v_session_status <> 'in_progress' then
    raise exception 'session is not in progress';
  end if;

  -- The question must be an ACTIVE question of the SAME course (spec S/AB).
  select * into v_question from public.questions
  where id = p_question_id and course_id = v_course_id and status = 'active';
  if v_question.id is null then
    raise exception 'question not found';
  end if;

  if p_confidence is not null
     and p_confidence not in ('guessing', 'unsure', 'pretty_sure', 'certain') then
    raise exception 'invalid confidence value';
  end if;

  -- Deterministic scoring per type (spec P: never AI arithmetic).
  if v_question.question_type in ('single_best_answer', 'multiple_response') then
    select coalesce(array_agg(value::uuid order by value::uuid), '{}') into v_selected
    from jsonb_array_elements_text(coalesce(p_response -> 'selected_option_ids', '[]'::jsonb));
    if array_length(v_selected, 1) is null then
      raise exception 'response requires selected_option_ids';
    end if;
    -- Selected ids must all belong to this question.
    if exists (
      select 1 from unnest(v_selected) sid
      where not exists (
        select 1 from public.question_options o
        where o.id = sid and o.question_id = v_question.id
      )
    ) then
      raise exception 'response references unknown options';
    end if;
    select coalesce(array_agg(o.id order by o.id), '{}') into v_correct
    from public.question_options o
    where o.question_id = v_question.id and o.is_correct;
    v_is_correct := v_selected = v_correct;

  elsif v_question.question_type = 'ordered_response' then
    select coalesce(array_agg(value::uuid), '{}') into v_selected
    from jsonb_array_elements_text(coalesce(p_response -> 'ordered_option_ids', '[]'::jsonb));
    if array_length(v_selected, 1) is null then
      raise exception 'response requires ordered_option_ids';
    end if;
    select coalesce(array_agg(o.id order by o.correct_position), '{}') into v_correct_order
    from public.question_options o
    where o.question_id = v_question.id and o.correct_position is not null;
    v_is_correct := v_selected = v_correct_order;

  elsif v_question.question_type = 'numeric_calculation' then
    if jsonb_typeof(p_response -> 'value') <> 'number' then
      raise exception 'response requires a numeric value';
    end if;
    v_value := (p_response ->> 'value')::numeric;
    v_is_correct := abs(v_value - v_question.expected_value) <= v_question.tolerance;

  else
    raise exception 'unsupported question type %', v_question.question_type;
  end if;

  -- Lock the answer (spec W): the unique constraint makes re-answering a hard
  -- error; a recorded attempt is never updated or replaced. Because the whole
  -- function is one transaction, a duplicate submit aborts HERE — before any
  -- mastery arithmetic — so a double submit can never double-update mastery
  -- (spec AC).
  begin
    insert into public.question_attempts
      (session_id, question_id, course_id, response, is_correct,
       response_time_ms, confidence)
    values
      (p_session_id, p_question_id, v_course_id, p_response, v_is_correct,
       p_response_time_ms, p_confidence)
    returning id into v_attempt_id;
  exception when unique_violation then
    raise exception 'question already answered in this session';
  end;

  -- -------------------------------------------------------------------------
  -- Mastery update (spec D/E/F/G/H/I/R/K — algorithm version 1).
  -- Deterministic mirror of @avidia/mastery updateMastery(). Runs only for
  -- questions linked to a concept; concept-less questions score normally but
  -- move no mastery (there is nothing to attribute the evidence to).
  -- -------------------------------------------------------------------------
  if v_question.concept_id is not null then
    -- Difficulty weight (spec F): correct-hard counts more; incorrect-easy
    -- counts more.
    if v_is_correct then
      v_diff_w := case v_question.difficulty
        when 'easy' then 0.8 when 'moderate' then 1.0 else 1.25 end;
      -- Cognitive weight applies to CORRECT answers only (spec G).
      v_cog_w := case v_question.cognitive_level
        when 'recall' then 0.85
        when 'understanding' then 0.95
        when 'application' then 1.1
        when 'analysis' then 1.2
        else 1.25 end;
      v_conf_w := case p_confidence
        when 'guessing' then 0.55
        when 'unsure' then 0.8
        when 'pretty_sure' then 1.0
        when 'certain' then 1.1
        else 1.0 end;
    else
      v_diff_w := case v_question.difficulty
        when 'easy' then 1.25 when 'moderate' then 1.0 else 0.8 end;
      v_cog_w := 1.0;
      -- Confidence calibration (spec H): confident errors weigh more;
      -- admitted uncertainty is never punished relative to them.
      v_conf_w := case p_confidence
        when 'guessing' then 0.85
        when 'unsure' then 0.9
        when 'pretty_sure' then 1.05
        when 'certain' then 1.15
        else 1.0 end;
    end if;
    -- Response time is EXCLUDED in v1 (spec I) — factor 1.0. Combined weight
    -- is clamped so no metadata combination dominates.
    v_weight := round(least(2.0, greatest(0.25, v_diff_w * v_cog_w * v_conf_w * 1.0)), 6);

    -- One aggregate row per user × course × concept; SELECT ... FOR UPDATE
    -- serializes concurrent submissions on the same concept (spec AC).
    select * into v_mastery from public.concept_mastery
    where user_id = v_user_id and course_id = v_course_id
      and concept_id = v_question.concept_id
    for update;
    if v_mastery.user_id is null then
      insert into public.concept_mastery (user_id, course_id, concept_id)
      values (v_user_id, v_course_id, v_question.concept_id)
      on conflict (user_id, course_id, concept_id) do nothing;
      select * into v_mastery from public.concept_mastery
      where user_id = v_user_id and course_id = v_course_id
        and concept_id = v_question.concept_id
      for update;
    end if;

    v_m_before := least(1, greatest(0, v_mastery.mastery));
    -- Bounded update (spec E/AK): diminishing gains, capped single steps.
    if v_is_correct then
      v_m_after := v_m_before + least(0.3 * v_weight * (1 - v_m_before), 0.25);
    else
      v_m_after := v_m_before - least(0.4 * v_weight * greatest(v_m_before, 0.35), 0.3);
    end if;
    v_m_after := round(least(1, greatest(0, v_m_after)), 6);

    -- Misconception severity (spec R): confident errors accumulate; correct
    -- answers decay it.
    if v_is_correct then
      v_severity := round(v_mastery.misconception_severity * 0.5, 6);
    else
      v_severity := v_mastery.misconception_severity + case p_confidence
        when 'certain' then 0.30 when 'pretty_sure' then 0.20 else 0.10 end;
      v_severity := round(least(1, greatest(0, v_severity)), 6);
    end if;

    -- Spaced-review stage (spec K): correct advances (a lucky guess earns no
    -- schedule relief), incorrect resets, ladder saturates.
    if not v_is_correct then
      v_stage := 0;
    elsif p_confidence = 'guessing' then
      v_stage := v_mastery.review_stage;
    else
      v_stage := least(v_mastery.review_stage + 1, 4);
    end if;
    v_next_review := v_now + make_interval(hours => v_intervals[v_stage + 1]);

    update public.concept_mastery
    set mastery = v_m_after,
        attempts_count = v_mastery.attempts_count + 1,
        correct_count = v_mastery.correct_count + case when v_is_correct then 1 else 0 end,
        misconception_severity = v_severity,
        review_stage = v_stage,
        last_attempt_at = v_now,
        next_review_at = v_next_review,
        algorithm_version = v_algorithm_version
    where user_id = v_user_id and course_id = v_course_id
      and concept_id = v_question.concept_id;

    -- Audit trail (spec Z): the exact update, traceable to its attempt.
    -- unique(attempt_id) is the idempotency backstop (spec AC).
    insert into public.mastery_events
      (attempt_id, user_id, course_id, concept_id, is_correct, evidence_weight,
       mastery_before, mastery_after, misconception_severity_after,
       review_stage_after, next_review_at, algorithm_version)
    values
      (v_attempt_id, v_user_id, v_course_id, v_question.concept_id,
       v_is_correct, v_weight, v_m_before, v_m_after, v_severity, v_stage,
       v_next_review, v_algorithm_version);

    v_mastery_json := jsonb_build_object(
      'concept_id', v_question.concept_id,
      'mastery', v_m_after,
      'mastery_delta', round(v_m_after - v_m_before, 6),
      'attempts_count', v_mastery.attempts_count + 1,
      'correct_count', v_mastery.correct_count + case when v_is_correct then 1 else 0 end,
      'misconception_severity', v_severity,
      'review_stage', v_stage,
      'next_review_at', v_next_review,
      'algorithm_version', v_algorithm_version
    );
  end if;

  -- Reveal answers and rationales only now, after the attempt is recorded.
  select jsonb_agg(jsonb_build_object(
    'id', o.id,
    'ordinal', o.ordinal,
    'is_correct', o.is_correct,
    'correct_position', o.correct_position,
    'rationale', o.rationale
  ) order by o.ordinal) into v_options
  from public.question_options o
  where o.question_id = v_question.id;

  return jsonb_build_object(
    'is_correct', v_is_correct,
    'rationale', v_question.rationale,
    'expected_value', v_question.expected_value,
    'tolerance', v_question.tolerance,
    'answer_unit', v_question.answer_unit,
    'rounding_note', v_question.rounding_note,
    'options', coalesce(v_options, '[]'::jsonb),
    'mastery', v_mastery_json
  );
end;
$$;

-- Grants are unchanged from 0007 (same signature): owners submit via their
-- own JWT; anonymous may not.
revoke all on function
  public.submit_question_attempt(uuid, uuid, jsonb, integer, text)
  from public, anon;
grant execute on function
  public.submit_question_attempt(uuid, uuid, jsonb, integer, text)
  to authenticated;
