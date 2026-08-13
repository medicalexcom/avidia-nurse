-- M6: nursing concept and knowledge model (Playbook §6 Concept/CourseConcept,
-- §7 concepts/course_concepts, §9 ingestion steps 9–10 and 13, §10 ontology;
-- ADR-0014 taxonomy, ADR-0015 normalization, ADR-0016 extraction, ADR-0017
-- relationships).
--
-- Deviation from the Playbook §7 sketch (recorded in ADR-0014): the sketch
-- shows a GLOBAL `concepts` table (canonical_name unique) plus a
-- `course_concepts` join. Because M6 concepts are AI-extracted from private
-- student uploads, a shared namespace could leak one student's course
-- content to another (spec A). We therefore scope concepts to a course and
-- fold the Playbook's course_concepts fields (emphasis_score, source_count)
-- into the course-scoped concept row. A future validated PLATFORM ontology
-- can be layered on top with a nullable ontology_id without breaking this.
--
-- Model:
--   * concepts           course-scoped, deduplicated by normalized_key
--   * concept_aliases    "DKA" → Diabetic Ketoacidosis (course-scoped)
--   * concept_sources    many-to-many concept ↔ source_chunk provenance
--   * concept_relationships  directed, typed, evidence-backed
--   * documents.knowledge_* a THIRD lifecycle (M4 read, M5 retrieve, M6 know)
--   * all writes flow through the worker-only apply_concept_extraction RPC;
--     clients are read-only everywhere (spec P/R).

-- ---------------------------------------------------------------------------
-- documents: knowledge lifecycle (separate from extraction and indexing)
-- ---------------------------------------------------------------------------

alter table public.documents
  add column knowledge_status text not null default 'pending' check (
    knowledge_status in ('pending', 'extracting', 'ready', 'failed')
  ),
  add column knowledge_attempts integer not null default 0
    check (knowledge_attempts >= 0),
  -- Internal diagnostics (provider errors, stage markers); never student-facing.
  add column knowledge_detail text null
    check (knowledge_detail is null or length(knowledge_detail) <= 2000),
  add column knowledge_at timestamptz null,
  -- Cost control (spec S): hash of chunk ids+contents and extraction/prompt
  -- versions at the last successful run. When a claim sees an unchanged
  -- fingerprint the worker skips the AI call entirely.
  add column knowledge_fingerprint text null
    check (knowledge_fingerprint is null or length(knowledge_fingerprint) <= 128);

-- ---------------------------------------------------------------------------
-- concepts
-- ---------------------------------------------------------------------------

create table public.concepts (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  -- Display form, e.g. "Diabetic Ketoacidosis".
  canonical_name text not null check (length(canonical_name) between 2 and 200),
  -- Deterministic normalization of canonical_name (lowercase, punctuation
  -- folded, whitespace collapsed) — the course-scoped deduplication key.
  normalized_key text not null check (length(normalized_key) between 2 and 200),
  concept_type text not null check (
    concept_type in (
      'disease_disorder', 'pathophysiology', 'sign_symptom', 'assessment',
      'laboratory', 'diagnostic', 'medication', 'intervention',
      'nursing_priority', 'complication', 'risk_factor', 'procedure',
      'safety', 'patient_education', 'anatomy_physiology', 'calculation',
      'other'
    )
  ),
  -- Short grounded description distilled from course material (nullable —
  -- spec H: dimensions are extensible, never forced).
  summary text null check (summary is null or length(summary) <= 1000),
  status text not null default 'active' check (status in ('active', 'archived')),
  -- 'ai' rows are prunable when their last supporting source disappears;
  -- 'user' rows (future curation) are never auto-pruned (spec M).
  origin text not null default 'ai' check (origin in ('ai', 'user')),
  -- Transparent evidence-based emphasis (spec L; Playbook §9 step 13):
  --   supporting_links + 2×distinct_documents
  --   + 3×distinct documents typed course_objectives or study_guide.
  -- Recomputed inside apply_concept_extraction; never an exam prediction.
  emphasis_score numeric not null default 0 check (emphasis_score >= 0),
  -- Extraction audit (spec E): who produced this concept first.
  ai_provider text null check (ai_provider is null or length(ai_provider) <= 80),
  ai_model text null check (ai_model is null or length(ai_model) <= 120),
  prompt_version text null check (prompt_version is null or length(prompt_version) <= 40),
  extraction_version text null check (extraction_version is null or length(extraction_version) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint concepts_course_key_unique unique (course_id, normalized_key)
);

create index concepts_course_id_idx on public.concepts (course_id, status);

create trigger concepts_set_updated_at
  before update on public.concepts
  for each row execute function public.set_updated_at();

alter table public.concepts enable row level security;
alter table public.concepts force row level security;

create policy concepts_select_own on public.concepts
  for select
  using (
    exists (
      select 1 from public.courses c
      where c.id = concepts.course_id
        and c.user_id = (select auth.uid())
    )
  );

revoke all on table public.concepts from anon, authenticated;
grant select on table public.concepts to authenticated;

-- ---------------------------------------------------------------------------
-- concept_aliases
-- ---------------------------------------------------------------------------

create table public.concept_aliases (
  id uuid primary key default gen_random_uuid(),
  concept_id uuid not null references public.concepts (id) on delete cascade,
  -- Denormalized for cheap RLS and course-wide alias resolution.
  course_id uuid not null references public.courses (id) on delete cascade,
  alias text not null check (length(alias) between 1 and 200),
  normalized_alias text not null check (length(normalized_alias) between 1 and 200),
  created_at timestamptz not null default now(),
  -- One meaning per alias per course: "DKA" cannot point at two concepts.
  constraint concept_aliases_course_alias_unique unique (course_id, normalized_alias)
);

create index concept_aliases_concept_id_idx on public.concept_aliases (concept_id);

alter table public.concept_aliases enable row level security;
alter table public.concept_aliases force row level security;

create policy concept_aliases_select_own on public.concept_aliases
  for select
  using (
    exists (
      select 1 from public.courses c
      where c.id = concept_aliases.course_id
        and c.user_id = (select auth.uid())
    )
  );

revoke all on table public.concept_aliases from anon, authenticated;
grant select on table public.concept_aliases to authenticated;

-- ---------------------------------------------------------------------------
-- concept_sources: concept ↔ source_chunk provenance (spec C/Q)
-- ---------------------------------------------------------------------------

create table public.concept_sources (
  concept_id uuid not null references public.concepts (id) on delete cascade,
  chunk_id uuid not null references public.source_chunks (id) on delete cascade,
  -- Denormalized (derived server-side, never trusted from input) so evidence
  -- queries and re-extraction cleanup are single-table cheap.
  course_id uuid not null references public.courses (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  extraction_version text not null check (length(extraction_version) between 1 and 40),
  created_at timestamptz not null default now(),
  primary key (concept_id, chunk_id)
);

create index concept_sources_chunk_id_idx on public.concept_sources (chunk_id);
create index concept_sources_document_id_idx on public.concept_sources (document_id);
create index concept_sources_course_id_idx on public.concept_sources (course_id);

alter table public.concept_sources enable row level security;
alter table public.concept_sources force row level security;

create policy concept_sources_select_own on public.concept_sources
  for select
  using (
    exists (
      select 1 from public.courses c
      where c.id = concept_sources.course_id
        and c.user_id = (select auth.uid())
    )
  );

revoke all on table public.concept_sources from anon, authenticated;
grant select on table public.concept_sources to authenticated;

-- ---------------------------------------------------------------------------
-- concept_relationships (spec I)
-- ---------------------------------------------------------------------------

create table public.concept_relationships (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  source_concept_id uuid not null references public.concepts (id) on delete cascade,
  target_concept_id uuid not null references public.concepts (id) on delete cascade,
  relationship_type text not null check (
    relationship_type in (
      'may_cause', 'may_lead_to', 'associated_with', 'treats',
      'adverse_effect_of', 'assessment_of', 'commonly_confused_with',
      'prerequisite_of'
    )
  ),
  status text not null default 'proposed' check (status in ('proposed', 'confirmed')),
  -- Evidence chunk. ON DELETE CASCADE is deliberate (spec O): when chunks are
  -- rebuilt or their document is deleted, AI-proposed relationships lose
  -- their evidence and must not stay silently active. Nullable only for
  -- future user-confirmed relationships.
  chunk_id uuid null references public.source_chunks (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint concept_relationships_not_self check (source_concept_id <> target_concept_id),
  constraint concept_relationships_unique unique (
    course_id, source_concept_id, target_concept_id, relationship_type
  )
);

create index concept_relationships_source_idx
  on public.concept_relationships (source_concept_id);
create index concept_relationships_target_idx
  on public.concept_relationships (target_concept_id);

alter table public.concept_relationships enable row level security;
alter table public.concept_relationships force row level security;

create policy concept_relationships_select_own on public.concept_relationships
  for select
  using (
    exists (
      select 1 from public.courses c
      where c.id = concept_relationships.course_id
        and c.user_id = (select auth.uid())
    )
  );

revoke all on table public.concept_relationships from anon, authenticated;
grant select on table public.concept_relationships to authenticated;

-- ---------------------------------------------------------------------------
-- emphasis recomputation (shared by the RPC and the cleanup trigger)
-- ---------------------------------------------------------------------------

create or replace function public.recompute_concept_emphasis(p_course_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  -- Transparent, evidence-based (spec L): more supporting chunks, more
  -- distinct documents, and presence in objectives/study-guide documents
  -- raise emphasis. This is a study-priority signal, NOT an exam prediction.
  update public.concepts c
  set emphasis_score = coalesce(agg.score, 0)
  from (
    select
      cs.concept_id,
      count(*)::numeric
        + 2 * count(distinct cs.document_id)
        + 3 * count(distinct cs.document_id)
            filter (where d.document_type in ('course_objectives', 'study_guide'))
        as score
    from public.concept_sources cs
    join public.documents d on d.id = cs.document_id
    where cs.course_id = p_course_id
    group by cs.concept_id
  ) agg
  where c.id = agg.concept_id and c.course_id = p_course_id;

  update public.concepts c
  set emphasis_score = 0
  where c.course_id = p_course_id
    and c.emphasis_score <> 0
    and not exists (select 1 from public.concept_sources cs where cs.concept_id = c.id);
$$;

revoke all on function public.recompute_concept_emphasis(uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- atomic, idempotent extraction persistence (worker-only)
-- ---------------------------------------------------------------------------

create or replace function public.apply_concept_extraction(
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
  v_provider text := p_payload #>> '{extraction,provider}';
  v_model text := p_payload #>> '{extraction,model}';
  v_prompt_version text := p_payload #>> '{extraction,prompt_version}';
  v_extraction_version text := p_payload #>> '{extraction,extraction_version}';
  v_concept jsonb;
  v_alias jsonb;
  v_relationship jsonb;
  v_concept_id uuid;
  v_source_id uuid;
  v_target_id uuid;
  v_chunk_id uuid;
  v_key text;
  v_name text;
  v_concept_count integer := 0;
  v_link_count integer := 0;
  v_relationship_count integer := 0;
  v_pruned integer := 0;
begin
  -- course_id derives from the document, never from the caller: extraction
  -- output can never be attributed to a different course (spec R).
  select course_id into v_course_id from public.documents where id = p_document_id;
  if v_course_id is null then
    raise exception 'document % not found', p_document_id;
  end if;
  if v_extraction_version is null or length(v_extraction_version) = 0 then
    raise exception 'extraction_version is required';
  end if;

  -- Idempotent re-run (spec N/O): this document's previous evidence is
  -- withdrawn before the new evidence lands, in one transaction. Links and
  -- relationships from OTHER documents are untouched.
  delete from public.concept_sources where document_id = p_document_id;
  delete from public.concept_relationships cr
  using public.source_chunks sc
  where cr.chunk_id = sc.id and sc.document_id = p_document_id;

  for v_concept in
    select * from jsonb_array_elements(coalesce(p_payload -> 'concepts', '[]'::jsonb))
  loop
    v_key := v_concept ->> 'key';
    v_name := v_concept ->> 'name';
    if v_key is null or v_name is null then
      raise exception 'concept entries require key and name';
    end if;

    -- Resolve in dedup order (spec F, ADR-0015):
    -- 1. exact normalized key; 2. existing alias claiming that key;
    -- 3. one of the candidate's alias keys matching an existing concept.
    select id into v_concept_id
    from public.concepts
    where course_id = v_course_id and normalized_key = v_key;

    if v_concept_id is null then
      select concept_id into v_concept_id
      from public.concept_aliases
      where course_id = v_course_id and normalized_alias = v_key;
    end if;

    if v_concept_id is null then
      select c.id into v_concept_id
      from public.concepts c
      join jsonb_array_elements(coalesce(v_concept -> 'aliases', '[]'::jsonb)) a
        on c.normalized_key = a ->> 'key'
      where c.course_id = v_course_id
      limit 1;
      -- Prefer the fullest deterministic name (DKA → Diabetic Ketoacidosis):
      -- promote the candidate's longer canonical name and keep the old name
      -- as an alias, unless the new key is already claimed.
      if v_concept_id is not null then
        update public.concepts c
        set canonical_name = v_name, normalized_key = v_key
        where c.id = v_concept_id
          and length(v_name) > length(c.canonical_name)
          and not exists (
            select 1 from public.concepts c2
            where c2.course_id = v_course_id and c2.normalized_key = v_key
          );
      end if;
    end if;

    if v_concept_id is null then
      insert into public.concepts
        (course_id, canonical_name, normalized_key, concept_type, summary,
         ai_provider, ai_model, prompt_version, extraction_version)
      values
        (v_course_id, v_name, v_key, coalesce(v_concept ->> 'type', 'other'),
         nullif(v_concept ->> 'summary', ''),
         v_provider, v_model, v_prompt_version, v_extraction_version)
      returning id into v_concept_id;
      v_concept_count := v_concept_count + 1;
    else
      -- Fill a missing summary; never overwrite an existing one silently.
      update public.concepts
      set summary = nullif(v_concept ->> 'summary', '')
      where id = v_concept_id
        and summary is null
        and nullif(v_concept ->> 'summary', '') is not null;
    end if;

    -- Keep the alias claimed by the old canonical name when a promotion
    -- happened, and record the candidate's aliases (first claim wins).
    for v_alias in
      select * from jsonb_array_elements(coalesce(v_concept -> 'aliases', '[]'::jsonb))
    loop
      if (v_alias ->> 'key') is not null
         and (v_alias ->> 'key') <> v_key
         and not exists (
           select 1 from public.concepts c2
           where c2.course_id = v_course_id and c2.normalized_key = v_alias ->> 'key'
         ) then
        insert into public.concept_aliases (concept_id, course_id, alias, normalized_alias)
        values (v_concept_id, v_course_id, v_alias ->> 'alias', v_alias ->> 'key')
        on conflict (course_id, normalized_alias) do nothing;
      end if;
    end loop;

    -- Provenance links; chunk must belong to THIS document (spec C).
    insert into public.concept_sources
      (concept_id, chunk_id, course_id, document_id, extraction_version)
    select v_concept_id, sc.id, v_course_id, p_document_id, v_extraction_version
    from jsonb_array_elements_text(coalesce(v_concept -> 'chunk_ids', '[]'::jsonb)) as cid
    join public.source_chunks sc on sc.id = cid::uuid
    where sc.document_id = p_document_id
    on conflict (concept_id, chunk_id) do nothing;
  end loop;

  select count(*) into v_link_count
  from public.concept_sources where document_id = p_document_id;

  for v_relationship in
    select * from jsonb_array_elements(coalesce(p_payload -> 'relationships', '[]'::jsonb))
  loop
    select id into v_source_id from public.concepts
    where course_id = v_course_id and normalized_key = v_relationship ->> 'source_key';
    if v_source_id is null then
      select concept_id into v_source_id from public.concept_aliases
      where course_id = v_course_id and normalized_alias = v_relationship ->> 'source_key';
    end if;

    select id into v_target_id from public.concepts
    where course_id = v_course_id and normalized_key = v_relationship ->> 'target_key';
    if v_target_id is null then
      select concept_id into v_target_id from public.concept_aliases
      where course_id = v_course_id and normalized_alias = v_relationship ->> 'target_key';
    end if;

    select sc.id into v_chunk_id
    from public.source_chunks sc
    where sc.id = (v_relationship ->> 'chunk_id')::uuid
      and sc.document_id = p_document_id;

    -- Unresolvable endpoints or foreign evidence: skip, never guess (spec K).
    if v_source_id is not null and v_target_id is not null
       and v_source_id <> v_target_id and v_chunk_id is not null then
      insert into public.concept_relationships
        (course_id, source_concept_id, target_concept_id, relationship_type, chunk_id)
      values
        (v_course_id, v_source_id, v_target_id,
         v_relationship ->> 'type', v_chunk_id)
      on conflict (course_id, source_concept_id, target_concept_id, relationship_type)
        do nothing;
      v_relationship_count := v_relationship_count + 1;
    end if;
  end loop;

  -- Orphan prune (spec M): AI concepts whose last supporting source is gone.
  delete from public.concepts c
  where c.course_id = v_course_id
    and c.origin = 'ai'
    and not exists (select 1 from public.concept_sources cs where cs.concept_id = c.id);
  get diagnostics v_pruned = row_count;

  perform public.recompute_concept_emphasis(v_course_id);

  return jsonb_build_object(
    'new_concepts', v_concept_count,
    'links', v_link_count,
    'relationships', v_relationship_count,
    'pruned', v_pruned
  );
end;
$$;

revoke all on function public.apply_concept_extraction(uuid, jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- document deletion cleanup (spec O / manual steps 13–14)
-- ---------------------------------------------------------------------------

-- Chunk/link/relationship rows cascade with the document; this trigger prunes
-- AI concepts that just lost their last source and refreshes emphasis so no
-- stale knowledge survives a deletion. No-op mid-course-delete (the cascade
-- removes concepts itself).
create or replace function public.cleanup_course_concepts_after_document_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.courses where id = old.course_id) then
    delete from public.concepts c
    where c.course_id = old.course_id
      and c.origin = 'ai'
      and not exists (select 1 from public.concept_sources cs where cs.concept_id = c.id);
    perform public.recompute_concept_emphasis(old.course_id);
  end if;
  return old;
end;
$$;

create trigger documents_cleanup_concepts
  after delete on public.documents
  for each row execute function public.cleanup_course_concepts_after_document_delete();
