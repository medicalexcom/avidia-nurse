-- No-upload question generation ("course material or any upload supersedes
-- LLM, but if no uploads, use the course name and LLM to study, generate
-- questions... as needed"). M7 questions today are strictly document-
-- grounded, bulk, per-document (packages/assessment + apps/worker/src/
-- questions.ts) — a course with zero processed documents has zero concepts
-- and therefore zero questions, with no fallback. case_study/simulation/
-- tutor (M11, migrations 0018/0019) already have exactly this course-first,
-- general-knowledge-fallback policy; this migration extends the same
-- ai_learning_requests worker loop with a new 'question_set' kind that:
--   1. proposes a concept/topic list from the bare course title when the
--      course has no concepts yet (persisted with a new origin so it is
--      naturally exempt from the existing document-evidence prune logic —
--      see apply_concept_extraction's orphan-delete and
--      cleanup_course_concepts_after_document_delete, both filtered on
--      origin = 'ai'), and
--   2. generates general-knowledge questions against that list, persisted
--      through a new course-scoped RPC (apply_question_generation hard-
--      requires a document_id and cannot be reused for a document-less
--      course).
-- Real uploaded material always wins going forward: once a document is
-- processed, M7's existing per-document pipeline generates its own
-- document-grounded concepts/questions independently — this path only ever
-- fills a gap, never overrides or is overridden by real material.

-- ---------------------------------------------------------------------------
-- ai_learning_requests: new kind reusing the existing claim/process/
-- complete/fail worker loop (attempts<3 budget, stale recovery, etc. all
-- apply unchanged).
-- ---------------------------------------------------------------------------

alter table public.ai_learning_requests
  drop constraint if exists ai_learning_requests_kind_check;

alter table public.ai_learning_requests
  add constraint ai_learning_requests_kind_check
  check (kind in ('case_study', 'simulation', 'tutor', 'question_set'));

-- ---------------------------------------------------------------------------
-- concepts: a new origin for LLM-proposed-from-course-title concepts. Kept
-- distinct from 'ai' (document-extraction concepts) specifically so the
-- existing prune logic — which only ever targets origin = 'ai' rows with no
-- surviving concept_sources — leaves these alone; they have no chunk
-- evidence to lose in the first place, so that prune rule does not apply to
-- them at all.
-- ---------------------------------------------------------------------------

alter table public.concepts
  drop constraint if exists concepts_origin_check;

alter table public.concepts
  add constraint concepts_origin_check
  check (origin in ('ai', 'user', 'ai_syllabus'));

-- ---------------------------------------------------------------------------
-- apply_syllabus_concepts: atomic, idempotent persistence of an LLM-proposed
-- concept list (worker-only). Deliberately simpler than
-- apply_concept_extraction: no document, no chunk provenance, no aliases or
-- relationships — those all require chunk evidence this path never has.
-- ---------------------------------------------------------------------------

create or replace function public.apply_syllabus_concepts(
  p_course_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider text := p_payload #>> '{extraction,provider}';
  v_model text := p_payload #>> '{extraction,model}';
  v_prompt_version text := p_payload #>> '{extraction,prompt_version}';
  v_extraction_version text := p_payload #>> '{extraction,extraction_version}';
  v_concept jsonb;
  v_concept_id uuid;
  v_key text;
  v_name text;
  v_concepts jsonb := '[]'::jsonb;
  v_new_count integer := 0;
begin
  if not exists (select 1 from public.courses where id = p_course_id) then
    raise exception 'course % not found', p_course_id;
  end if;
  if v_extraction_version is null or length(v_extraction_version) = 0 then
    raise exception 'extraction_version is required';
  end if;

  for v_concept in
    select * from jsonb_array_elements(coalesce(p_payload -> 'concepts', '[]'::jsonb))
  loop
    v_key := v_concept ->> 'key';
    v_name := v_concept ->> 'name';
    if v_key is null or v_name is null then
      raise exception 'concept entries require key and name';
    end if;

    -- Dedup against ANY existing concept for this course (real, document-
    -- extracted ones included) by normalized key — a syllabus proposal never
    -- shadows a concept the student's own material already established.
    select id into v_concept_id
    from public.concepts
    where course_id = p_course_id and normalized_key = v_key;

    if v_concept_id is null then
      insert into public.concepts
        (course_id, canonical_name, normalized_key, concept_type, summary,
         origin, ai_provider, ai_model, prompt_version, extraction_version)
      values
        (p_course_id, v_name, v_key, coalesce(v_concept ->> 'type', 'other'),
         nullif(v_concept ->> 'summary', ''),
         'ai_syllabus', v_provider, v_model, v_prompt_version, v_extraction_version)
      returning id into v_concept_id;
      v_new_count := v_new_count + 1;
    end if;

    v_concepts := v_concepts || jsonb_build_object(
      'id', v_concept_id, 'key', v_key, 'name', v_name
    );
  end loop;

  perform public.recompute_concept_emphasis(p_course_id);

  return jsonb_build_object('concepts', v_concepts, 'new_concepts', v_new_count);
end;
$$;

revoke all on function public.apply_syllabus_concepts(uuid, jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- apply_ondemand_question_generation: atomic, idempotent persistence of
-- general-knowledge questions for a course with no document to attach
-- provenance to (worker-only). Mirrors apply_question_generation's dedup-by-
-- content-hash insert, minus everything document-specific: no
-- question_sources rows (there is no document_id or chunk evidence),
-- generation_source is always 'on_demand', and there is no retire pass
-- (that pass exists to react to a document's evidence disappearing, which
-- cannot happen here).
-- ---------------------------------------------------------------------------

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

  return jsonb_build_object('inserted', v_inserted, 'skipped', v_skipped);
end;
$$;

revoke all on function public.apply_ondemand_question_generation(uuid, jsonb)
  from public, anon, authenticated;
