-- 0023 - Route newly generated questions through human review instead of
-- going live automatically (decided 2026-08-25, RELEASE_CHECKLIST.md Stage 3
-- "author seed content").
--
-- Finding: the content-review tool (content-review edge function,
-- app/(app)/review.tsx) has been complete and deployed for a while, and
-- correctly handles questions with status 'generated' or 'flagged'. But the
-- generation pipeline never actually produced 'generated' rows — the
-- clinical validation pipeline (packages/assessment/src/validate.ts) marked
-- every clean-passing question 'active' directly, and these two RPCs only
-- ever accepted 'active' or 'flagged' from the payload (anything else fell
-- back to 'flagged'). So every AI-generated question that passed automated
-- validation went straight to students with no human ever seeing it; only
-- the minority the automated checker itself flagged ever reached the review
-- queue. 'generated' existed in the schema (migration 0007) but nothing
-- ever wrote it.
--
-- Fix (matches a companion, non-migration change to
-- packages/assessment/src/validate.ts, which now emits 'generated' instead
-- of 'active' for clean questions): widen both generation RPCs' status
-- allow-list to accept 'generated', and widen the course-grounded retirement
-- sweeps (in apply_question_generation and the document-delete cleanup
-- trigger) to also retire orphaned 'generated' questions, not just
-- 'active'/'flagged' ones, so a question awaiting review whose source
-- document gets deleted doesn't linger forever un-retirable. 'active'
-- stays in the allow-list for backward compatibility (nothing currently
-- sends it, but accepting it is harmless) — only a reviewer's approval
-- through content-review is expected to produce it now.
--
-- Each function body below is otherwise byte-identical to its prior
-- version (0007, 0020) except the noted lines — CREATE OR REPLACE keeps the
-- existing grants (already revoked from public/anon/authenticated) and
-- trigger binding intact.

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
         -- CHANGED (0023): accept 'generated' in addition to 'active' /
         -- 'flagged' — this is how a clean-passing question now reaches the
         -- review queue instead of going live untouched.
         case
           when v_question ->> 'status' in ('active', 'flagged', 'generated')
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
  -- CHANGED (0023): also retire 'generated' rows (awaiting first review),
  -- not just 'active'/'flagged' ones — a question shouldn't sit in the
  -- review queue forever pointing at evidence that no longer exists.
  update public.questions q
  set status = 'retired'
  where q.course_id = v_course_id
    and q.source_type = 'course_grounded'
    and q.status in ('active', 'flagged', 'generated')
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

create or replace function public.cleanup_course_questions_after_document_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.courses where id = old.course_id) then
    -- CHANGED (0023): also retire 'generated' rows — same reasoning as the
    -- retirement sweep in apply_question_generation above.
    update public.questions q
    set status = 'retired'
    where q.course_id = old.course_id
      and q.source_type = 'course_grounded'
      and q.status in ('active', 'flagged', 'generated')
      and not exists (
        select 1 from public.question_sources qs where qs.question_id = q.id
      );
  end if;
  return old;
end;
$$;

create or replace function public.apply_ondemand_question_generation(
  p_course_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
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
begin
  if not exists (select 1 from public.courses where id = p_course_id) then
    raise exception 'course % not found', p_course_id;
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

    v_concept_id := null;
    if (v_question ->> 'concept_key') is not null then
      select id into v_concept_id from public.concepts
      where course_id = p_course_id
        and normalized_key = v_question ->> 'concept_key';
      if v_concept_id is null then
        select concept_id into v_concept_id from public.concept_aliases
        where course_id = p_course_id
          and normalized_alias = v_question ->> 'concept_key';
      end if;
    end if;

    -- Dedup (spec R, same convention as apply_question_generation): an
    -- existing question with the same content hash is reused, not
    -- duplicated.
    select id into v_question_id from public.questions
    where course_id = p_course_id and content_hash = v_hash;

    if v_question_id is null then
      insert into public.questions
        (course_id, concept_id, question_type, stem, difficulty,
         cognitive_level, source_type, generation_source, priority_frameworks,
         rationale, expected_value, tolerance, answer_unit, rounding_note,
         status, safety_flags, content_hash,
         ai_provider, ai_model, prompt_version, generation_version)
      values
        (p_course_id, v_concept_id,
         v_question ->> 'question_type',
         v_question ->> 'stem',
         v_question ->> 'difficulty',
         v_question ->> 'cognitive_level',
         -- Always general_knowledge: this RPC exists only for the no-upload
         -- path, never trust the payload for the claim a question is
         -- grounded in the student's own material (spec H).
         'general_knowledge',
         'on_demand',
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
         -- CHANGED (0023): accept 'generated' — same reasoning as
         -- apply_question_generation above.
         case
           when v_question ->> 'status' in ('active', 'flagged', 'generated')
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
          (v_question_id, p_course_id,
           (v_option ->> 'ordinal')::integer,
           v_option ->> 'text',
           coalesce((v_option ->> 'is_correct')::boolean, false),
           (v_option ->> 'correct_position')::integer,
           nullif(v_option ->> 'rationale', ''));
      end loop;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'inserted', v_inserted,
    'skipped', v_skipped
  );
end;
$$;

revoke all on function public.apply_ondemand_question_generation(uuid, jsonb)
  from public, anon, authenticated;
