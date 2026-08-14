-- M7: nursing question and assessment engine (Playbook §11 item schema, §15
-- question interaction, §16 model routing, §17 generation rules; ADR-0018
-- question schema, ADR-0019 generation strategy, ADR-0020 scoring
-- architecture, ADR-0021 validation strategy).
--
-- Model:
--   * questions          course-scoped generated items, deduplicated by
--                        content_hash; answer-revealing columns are NOT
--                        client-selectable (spec K "no answer leakage")
--   * question_options   normalized options with deterministic ordinal;
--                        is_correct / correct_position / rationale are
--                        server-only columns
--   * question_sources   question ↔ source_chunk provenance (spec Q)
--   * study_sessions     student practice sessions (spec T)
--   * question_attempts  immutable, server-scored responses (spec V/W);
--                        clients cannot write them directly — the ONLY path
--                        is the submit_question_attempt RPC
--   * question_feedback  student flags; stored, never auto-applied (spec AH)
--   * documents.question_* a FOURTH lifecycle (M4 read, M5 retrieve,
--                        M6 know, M7 practice)
--   * generation writes flow through the worker-only apply_question_generation
--     RPC; scoring flows through submit_question_attempt (spec AB).

-- ---------------------------------------------------------------------------
-- documents: question-generation lifecycle (independent of M4/M5/M6 states)
-- ---------------------------------------------------------------------------

alter table public.documents
  add column question_status text not null default 'pending' check (
    question_status in ('pending', 'generating', 'ready', 'failed')
  ),
  add column question_attempts_count integer not null default 0
    check (question_attempts_count >= 0),
  -- Internal diagnostics (provider errors, stage markers); never student-facing.
  add column question_detail text null
    check (question_detail is null or length(question_detail) <= 2000),
  add column question_at timestamptz null,
  -- Cost control (spec AD/Y): hash of the concept/chunk inputs and
  -- generation/prompt versions at the last successful run. An unchanged
  -- fingerprint means the worker skips the AI call entirely.
  add column question_fingerprint text null
    check (question_fingerprint is null or length(question_fingerprint) <= 128);

-- ---------------------------------------------------------------------------
-- questions (spec A/C/E/F/H/L/P/R/S)
-- ---------------------------------------------------------------------------

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  -- Primary concept; nullable and survives concept pruning (spec A).
  concept_id uuid null references public.concepts (id) on delete set null,
  question_type text not null check (
    question_type in (
      'single_best_answer', 'multiple_response', 'ordered_response',
      'numeric_calculation'
    )
  ),
  stem text not null check (length(stem) between 20 and 3000),
  difficulty text not null check (difficulty in ('easy', 'moderate', 'hard')),
  cognitive_level text not null check (
    cognitive_level in (
      'recall', 'understanding', 'application', 'analysis', 'prioritization'
    )
  ),
  -- course_grounded questions carry chunk provenance; general_knowledge is
  -- labeled and NEVER attributed to the student's materials (spec H).
  source_type text not null check (
    source_type in ('course_grounded', 'general_knowledge')
  ),
  -- How this question came to exist (audit, spec A): the per-document worker
  -- pipeline or a future on-demand path.
  generation_source text not null default 'document_pipeline' check (
    generation_source in ('document_pipeline', 'on_demand')
  ),
  -- Nursing prioritization frameworks involved (spec O); metadata, may be empty.
  priority_frameworks text[] not null default '{}' check (
    priority_frameworks <@ array[
      'abc', 'safety', 'acute_vs_chronic', 'unstable_vs_stable',
      'actual_vs_potential', 'least_restrictive'
    ]::text[]
  ),
  -- Teaching rationale (spec M): why correct is correct. NOT client-selectable
  -- before answering — returned by submit_question_attempt.
  rationale text not null check (length(rationale) between 20 and 4000),
  -- Deterministic math (spec P): numeric questions carry the expected value,
  -- tolerance, unit and rounding note as data; nothing is ever "computed by
  -- the AI" at answer time. Forbidden on non-numeric types.
  expected_value numeric null,
  tolerance numeric null check (tolerance is null or tolerance >= 0),
  answer_unit text null check (answer_unit is null or length(answer_unit) <= 40),
  rounding_note text null check (rounding_note is null or length(rounding_note) <= 200),
  constraint questions_numeric_fields check (
    case
      when question_type = 'numeric_calculation'
        then expected_value is not null and tolerance is not null
      else expected_value is null and tolerance is null
        and answer_unit is null and rounding_note is null
    end
  ),
  -- Lifecycle (spec S). The pipeline validates BEFORE persistence, so rows
  -- land 'active' (clean) or 'flagged' (carrying safety/quality warnings,
  -- spec L). Study selection only ever sees 'active' — enforced by RLS below.
  status text not null default 'generated' check (
    status in ('generated', 'active', 'flagged', 'rejected', 'retired')
  ),
  -- Validation warnings that caused 'flagged' (spec L); internal.
  safety_flags text[] not null default '{}',
  -- Dedup (spec R): hash of normalized type+stem+options; unique per course.
  content_hash text not null check (length(content_hash) between 16 and 128),
  -- Generation audit (spec AD).
  ai_provider text null check (ai_provider is null or length(ai_provider) <= 80),
  ai_model text null check (ai_model is null or length(ai_model) <= 120),
  prompt_version text null check (prompt_version is null or length(prompt_version) <= 40),
  generation_version text null check (
    generation_version is null or length(generation_version) <= 40
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint questions_course_hash_unique unique (course_id, content_hash)
);

create index questions_course_status_idx on public.questions (course_id, status);
create index questions_concept_id_idx on public.questions (concept_id);

create trigger questions_set_updated_at
  before update on public.questions
  for each row execute function public.set_updated_at();

alter table public.questions enable row level security;
alter table public.questions force row level security;

-- Students only ever see ACTIVE questions in their own courses (spec S/AB).
create policy questions_select_own_active on public.questions
  for select
  using (
    questions.status = 'active'
    and exists (
      select 1 from public.courses c
      where c.id = questions.course_id
        and c.user_id = (select auth.uid())
    )
  );

revoke all on table public.questions from anon, authenticated;
-- Column-level select grant (spec K, Playbook §15): rationale and the
-- deterministic numeric answer are NOT selectable by clients — they are
-- revealed only by submit_question_attempt after the answer is locked.
grant select (
  id, course_id, concept_id, question_type, stem, difficulty, cognitive_level,
  source_type, priority_frameworks, status, created_at, updated_at
) on table public.questions to authenticated;

-- ---------------------------------------------------------------------------
-- question_options (spec B/N)
-- ---------------------------------------------------------------------------

create table public.question_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions (id) on delete cascade,
  -- Denormalized for cheap RLS.
  course_id uuid not null references public.courses (id) on delete cascade,
  -- Deterministic presentation order (spec B): fixed at generation time so a
  -- question renders identically on every device and revisit.
  ordinal integer not null check (ordinal >= 1),
  option_text text not null check (length(option_text) between 1 and 500),
  is_correct boolean not null default false,
  -- Position in the correct sequence for ordered_response (1-based); null for
  -- other types.
  correct_position integer null check (correct_position is null or correct_position >= 1),
  -- Per-option teaching rationale (spec M: why each distractor is wrong).
  rationale text null check (rationale is null or length(rationale) <= 1000),
  created_at timestamptz not null default now(),
  constraint question_options_question_ordinal_unique unique (question_id, ordinal)
);

create index question_options_question_id_idx on public.question_options (question_id);

alter table public.question_options enable row level security;
alter table public.question_options force row level security;

create policy question_options_select_own on public.question_options
  for select
  using (
    exists (
      select 1 from public.courses c
      where c.id = question_options.course_id
        and c.user_id = (select auth.uid())
    )
    and exists (
      select 1 from public.questions q
      where q.id = question_options.question_id
        and q.status = 'active'
    )
  );

revoke all on table public.question_options from anon, authenticated;
-- Column-level select grant (spec K "no answer leakage"): is_correct,
-- correct_position and the option rationale are server-only; the RPC reveals
-- them after the attempt is recorded.
grant select (
  id, question_id, course_id, ordinal, option_text, created_at
) on table public.question_options to authenticated;

-- ---------------------------------------------------------------------------
-- question_sources: question ↔ source_chunk provenance (spec G/Q)
-- ---------------------------------------------------------------------------

create table public.question_sources (
  question_id uuid not null references public.questions (id) on delete cascade,
  chunk_id uuid not null references public.source_chunks (id) on delete cascade,
  -- Denormalized (derived server-side, never trusted from input).
  course_id uuid not null references public.courses (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  generation_version text not null check (length(generation_version) between 1 and 40),
  created_at timestamptz not null default now(),
  primary key (question_id, chunk_id)
);

create index question_sources_chunk_id_idx on public.question_sources (chunk_id);
create index question_sources_document_id_idx on public.question_sources (document_id);
create index question_sources_course_id_idx on public.question_sources (course_id);

alter table public.question_sources enable row level security;
alter table public.question_sources force row level security;

create policy question_sources_select_own on public.question_sources
  for select
  using (
    exists (
      select 1 from public.courses c
      where c.id = question_sources.course_id
        and c.user_id = (select auth.uid())
    )
  );

revoke all on table public.question_sources from anon, authenticated;
grant select on table public.question_sources to authenticated;

-- ---------------------------------------------------------------------------
-- study_sessions (spec T)
-- ---------------------------------------------------------------------------

create table public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  session_type text not null default 'practice' check (session_type in ('practice')),
  status text not null default 'in_progress' check (
    status in ('in_progress', 'completed', 'abandoned')
  ),
  -- How many questions the student asked for; attempts may be fewer if the
  -- session is abandoned.
  planned_question_count integer not null check (planned_question_count between 1 and 50),
  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index study_sessions_course_status_idx on public.study_sessions (course_id, status);

create trigger study_sessions_set_updated_at
  before update on public.study_sessions
  for each row execute function public.set_updated_at();

alter table public.study_sessions enable row level security;
alter table public.study_sessions force row level security;

create policy study_sessions_select_own on public.study_sessions
  for select
  using (
    exists (
      select 1 from public.courses c
      where c.id = study_sessions.course_id
        and c.user_id = (select auth.uid())
    )
  );

create policy study_sessions_insert_own on public.study_sessions
  for insert
  with check (
    exists (
      select 1 from public.courses c
      where c.id = study_sessions.course_id
        and c.user_id = (select auth.uid())
    )
  );

create policy study_sessions_update_own on public.study_sessions
  for update
  using (
    exists (
      select 1 from public.courses c
      where c.id = study_sessions.course_id
        and c.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = study_sessions.course_id
        and c.user_id = (select auth.uid())
    )
  );

revoke all on table public.study_sessions from anon, authenticated;
grant select on table public.study_sessions to authenticated;
grant insert (course_id, session_type, planned_question_count)
  on table public.study_sessions to authenticated;
-- Clients may only move a session's lifecycle forward; attempts stay immutable.
grant update (status, completed_at) on table public.study_sessions to authenticated;

-- ---------------------------------------------------------------------------
-- question_attempts (spec T/V/W): immutable, server-scored
-- ---------------------------------------------------------------------------

create table public.question_attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.study_sessions (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete cascade,
  -- Denormalized for cheap RLS and M8 analysis.
  course_id uuid not null references public.courses (id) on delete cascade,
  -- The raw response exactly as submitted:
  --   single/multiple: {"selected_option_ids": [uuid...]}
  --   ordered:         {"ordered_option_ids": [uuid...]}
  --   numeric:         {"value": number}
  response jsonb not null,
  -- Scored SERVER-SIDE inside submit_question_attempt; clients never write it.
  is_correct boolean not null,
  response_time_ms integer null check (response_time_ms is null or response_time_ms >= 0),
  -- Optional self-reported confidence (spec U); captured, never scored in M7.
  confidence text null check (
    confidence is null
    or confidence in ('guessing', 'unsure', 'pretty_sure', 'certain')
  ),
  created_at timestamptz not null default now(),
  -- One locked answer per question per session (spec W).
  constraint question_attempts_session_question_unique unique (session_id, question_id)
);

create index question_attempts_session_id_idx on public.question_attempts (session_id);
create index question_attempts_question_id_idx on public.question_attempts (question_id);
create index question_attempts_course_id_idx on public.question_attempts (course_id);

alter table public.question_attempts enable row level security;
alter table public.question_attempts force row level security;

create policy question_attempts_select_own on public.question_attempts
  for select
  using (
    exists (
      select 1 from public.courses c
      where c.id = question_attempts.course_id
        and c.user_id = (select auth.uid())
    )
  );

-- No insert/update/delete policies or grants: the ONLY write path is the
-- SECURITY DEFINER submit_question_attempt RPC (spec V/W/AB).
revoke all on table public.question_attempts from anon, authenticated;
grant select on table public.question_attempts to authenticated;

-- ---------------------------------------------------------------------------
-- question_feedback (spec AH): stored, reviewed, never auto-applied
-- ---------------------------------------------------------------------------

create table public.question_feedback (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions (id) on delete cascade,
  course_id uuid not null references public.courses (id) on delete cascade,
  reason text not null check (
    reason in (
      'answer_wrong', 'question_unclear', 'rationale_unclear',
      'source_mismatch', 'other'
    )
  ),
  comment text null check (comment is null or length(comment) <= 1000),
  created_at timestamptz not null default now()
);

create index question_feedback_question_id_idx on public.question_feedback (question_id);

alter table public.question_feedback enable row level security;
alter table public.question_feedback force row level security;

create policy question_feedback_select_own on public.question_feedback
  for select
  using (
    exists (
      select 1 from public.courses c
      where c.id = question_feedback.course_id
        and c.user_id = (select auth.uid())
    )
  );

create policy question_feedback_insert_own on public.question_feedback
  for insert
  with check (
    exists (
      select 1 from public.courses c
      where c.id = question_feedback.course_id
        and c.user_id = (select auth.uid())
    )
    and exists (
      select 1 from public.questions q
      where q.id = question_feedback.question_id
        and q.course_id = question_feedback.course_id
    )
  );

revoke all on table public.question_feedback from anon, authenticated;
grant select on table public.question_feedback to authenticated;
grant insert (question_id, course_id, reason, comment)
  on table public.question_feedback to authenticated;

-- ---------------------------------------------------------------------------
-- atomic, idempotent generation persistence (worker-only)
-- ---------------------------------------------------------------------------

create or replace function public.apply_question_generation(
  p_document_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_course_id uuid;
  v_provider text := p_payload #>> '{generation,provider}';
  v_model text := p_payload #>> '{generation,model}';
  v_prompt_version text := p_payload #>> '{generation,prompt_version}';
  v_generation_version text := p_payload #>> '{generation,generation_version}';
  v_question jsonb;
  v_option jsonb;
  v_question_id uuid;
  v_concept_id uuid;
  v_hash text;
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_link_count integer := 0;
  v_retired integer := 0;
begin
  -- course_id derives from the document, never from the caller (spec AB).
  select course_id into v_course_id from public.documents where id = p_document_id;
  if v_course_id is null then
    raise exception 'document % not found', p_document_id;
  end if;
  if v_generation_version is null or length(v_generation_version) = 0 then
    raise exception 'generation_version is required';
  end if;

  for v_question in
    select * from jsonb_array_elements(coalesce(p_payload -> 'questions', '[]'::jsonb))
  loop
    v_hash := v_question ->> 'content_hash';
    if v_hash is null then
      raise exception 'question entries require content_hash';
    end if;

    -- Resolve the primary concept by normalized key or alias; unresolvable
    -- keys leave concept_id null rather than guessing (spec K).
    v_concept_id := null;
    if (v_question ->> 'concept_key') is not null then
      select id into v_concept_id from public.concepts
      where course_id = v_course_id
        and normalized_key = v_question ->> 'concept_key';
      if v_concept_id is null then
        select concept_id into v_concept_id from public.concept_aliases
        where course_id = v_course_id
          and normalized_alias = v_question ->> 'concept_key';
      end if;
    end if;

    -- Dedup (spec R): an existing question with the same content hash is
    -- reused, not duplicated — but its provenance links are refreshed so a
    -- re-generated document keeps honest evidence.
    select id into v_question_id from public.questions
    where course_id = v_course_id and content_hash = v_hash;

    if v_question_id is null then
      insert into public.questions
        (course_id, concept_id, question_type, stem, difficulty,
         cognitive_level, source_type, generation_source, priority_frameworks,
         rationale, expected_value, tolerance, answer_unit, rounding_note,
         status, safety_flags, content_hash,
         ai_provider, ai_model, prompt_version, generation_version)
      values
        (v_course_id, v_concept_id,
         v_question ->> 'question_type',
         v_question ->> 'stem',
         v_question ->> 'difficulty',
         v_question ->> 'cognitive_level',
         v_question ->> 'source_type',
         'document_pipeline',
         coalesce(
           (select array_agg(f) from jsonb_array_elements_text(
             coalesce(v_question -> 'priority_frameworks', '[]'::jsonb)) f),
           '{}'::text[]
         ),
         v_question ->> 'rationale',
         (v_question ->> 'expected_value')::numeric,
         (v_question ->> 'tolerance')::numeric,
         nullif(v_question ->> 'answer_unit', ''),
         nullif(v_question ->> 'rounding_note', ''),
         case
           when v_question ->> 'status' in ('active', 'flagged')
             then v_question ->> 'status'
           else 'flagged'
         end,
         coalesce(
           (select array_agg(f) from jsonb_array_elements_text(
             coalesce(v_question -> 'safety_flags', '[]'::jsonb)) f),
           '{}'::text[]
         ),
         v_hash, v_provider, v_model, v_prompt_version, v_generation_version)
      returning id into v_question_id;
      v_inserted := v_inserted + 1;

      for v_option in
        select * from jsonb_array_elements(coalesce(v_question -> 'options', '[]'::jsonb))
      loop
        insert into public.question_options
          (question_id, course_id, ordinal, option_text, is_correct,
           correct_position, rationale)
        values
          (v_question_id, v_course_id,
           (v_option ->> 'ordinal')::integer,
           v_option ->> 'text',
           coalesce((v_option ->> 'is_correct')::boolean, false),
           (v_option ->> 'correct_position')::integer,
           nullif(v_option ->> 'rationale', ''));
      end loop;
    else
      v_skipped := v_skipped + 1;
    end if;

    -- Provenance links; chunk must belong to THIS document (spec G/Q).
    insert into public.question_sources
      (question_id, chunk_id, course_id, document_id, generation_version)
    select v_question_id, sc.id, v_course_id, p_document_id, v_generation_version
    from jsonb_array_elements_text(coalesce(v_question -> 'chunk_ids', '[]'::jsonb)) as cid
    join public.source_chunks sc on sc.id = cid::uuid
    where sc.document_id = p_document_id
    on conflict (question_id, chunk_id) do nothing;
  end loop;

  select count(*) into v_link_count
  from public.question_sources where document_id = p_document_id;

  -- Course-grounded questions whose evidence is entirely gone lose their
  -- claim to the student's materials: retire, never silently keep (spec H/Q).
  update public.questions q
  set status = 'retired'
  where q.course_id = v_course_id
    and q.source_type = 'course_grounded'
    and q.status in ('active', 'flagged')
    and not exists (
      select 1 from public.question_sources qs where qs.question_id = q.id
    );
  get diagnostics v_retired = row_count;

  return jsonb_build_object(
    'inserted', v_inserted,
    'skipped', v_skipped,
    'links', v_link_count,
    'retired', v_retired
  );
end;
$$;

revoke all on function public.apply_question_generation(uuid, jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- server-side scoring (spec P/V/W; Playbook §15 steps 3–8)
-- ---------------------------------------------------------------------------

-- The ONLY way an attempt comes into existence. Runs as definer so it can
-- read the answer-revealing columns, but first verifies the CALLER owns the
-- session's course. Scoring is deterministic per type; the correct answer and
-- rationales are revealed only in the RETURN value, after the attempt row is
-- locked in.
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
  -- error; a recorded attempt is never updated or replaced.
  begin
    insert into public.question_attempts
      (session_id, question_id, course_id, response, is_correct,
       response_time_ms, confidence)
    values
      (p_session_id, p_question_id, v_course_id, p_response, v_is_correct,
       p_response_time_ms, p_confidence);
  exception when unique_violation then
    raise exception 'question already answered in this session';
  end;

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
    'options', coalesce(v_options, '[]'::jsonb)
  );
end;
$$;

-- Owners (via their own JWT) may submit; anonymous may not.
revoke all on function
  public.submit_question_attempt(uuid, uuid, jsonb, integer, text)
  from public, anon;
grant execute on function
  public.submit_question_attempt(uuid, uuid, jsonb, integer, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- document deletion cleanup (spec H/Q): no stale attribution
-- ---------------------------------------------------------------------------

-- question_sources cascade with the document; this trigger retires
-- course-grounded questions that just lost their last piece of evidence so no
-- question ever claims support from materials that no longer exist. No-op
-- mid-course-delete (the cascade removes questions itself).
create or replace function public.cleanup_course_questions_after_document_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.courses where id = old.course_id) then
    update public.questions q
    set status = 'retired'
    where q.course_id = old.course_id
      and q.source_type = 'course_grounded'
      and q.status in ('active', 'flagged')
      and not exists (
        select 1 from public.question_sources qs where qs.question_id = q.id
      );
  end if;
  return old;
end;
$$;

create trigger documents_cleanup_questions
  after delete on public.documents
  for each row execute function public.cleanup_course_questions_after_document_delete();
