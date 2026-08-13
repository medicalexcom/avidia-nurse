-- M5: semantic chunks, embeddings, pgvector retrieval (Playbook §7
-- source_chunks, §9 ingestion steps 7–8 and 11–12, §13/§19 M5 retrieval;
-- ADR-0011, ADR-0012, ADR-0013).
--
-- Scope note: this migration adds the retrieval layer on top of M4's
-- document_sections. Chunks are derived from sections by the indexing worker,
-- embedded server-side, and searched through a course-scoped, authorization-
-- checked RPC. Concepts/ontology (the Playbook's concepts and course_concepts
-- tables) are deferred with the founder's M5 directive; concept_id is present
-- but nullable and unconstrained until the ontology milestone adds its table.
--
-- Model:
--   * documents.index_status is a SEPARATE lifecycle from processing_status:
--     extraction (M4) answers "can the student read this?", indexing (M5)
--     answers "can study tools retrieve from this?". pending → indexing →
--     indexed | failed, worker-only (clients have no column grant).
--   * source_chunks carries the embedding, its provenance (source_locator +
--     section range), and embedding version metadata so a provider/model/
--     chunker change can trigger clean re-indexing.
--   * All chunk writes go through replace_source_chunks() — the same atomic
--     delete+insert idempotency contract as M4's replace_document_sections.
--   * search_course_chunks() performs hybrid retrieval (vector cosine +
--     Postgres full-text, reciprocal-rank fusion) and enforces course
--     ownership INSIDE the function — scoping is not a client courtesy.

-- ---------------------------------------------------------------------------
-- pgvector
-- ---------------------------------------------------------------------------

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- documents: indexing lifecycle (separate from extraction lifecycle)
-- ---------------------------------------------------------------------------

alter table public.documents
  add column index_status text not null default 'pending' check (
    index_status in ('pending', 'indexing', 'indexed', 'failed')
  ),
  add column index_attempts integer not null default 0
    check (index_attempts >= 0),
  -- Internal diagnostics only (provider errors, stage markers); never shown
  -- to students and intentionally absent from client column grants.
  add column index_detail text null
    check (index_detail is null or length(index_detail) <= 2000),
  add column indexed_at timestamptz null;

-- ---------------------------------------------------------------------------
-- source_chunks: retrievable course knowledge with provenance + embeddings
-- ---------------------------------------------------------------------------

create table public.source_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  -- Denormalized (and derived server-side from the document, never trusted
  -- from input) so retrieval filters and RLS are single-join cheap.
  course_id uuid not null references public.courses (id) on delete cascade,
  -- Reserved for the ontology milestone; no FK until concepts exists.
  concept_id uuid null,
  -- 0-based reading order of chunks within the document.
  ordinal integer not null check (ordinal >= 0),
  content text not null check (length(content) between 1 and 8000),
  -- Approximate size used by the chunker's budget (chars/4 heuristic).
  token_estimate integer not null check (token_estimate > 0),
  -- Human-usable provenance: {"type":"pptx","slide":17,"title":"..."} etc.
  -- (spec F). Never discarded after embedding.
  source_locator jsonb not null,
  -- M4 provenance link: the inclusive document_sections.sequence range this
  -- chunk was built from. Survives section-id churn on re-extraction because
  -- re-extraction always resets index_status and rebuilds chunks.
  section_start integer not null check (section_start >= 0),
  section_end integer not null check (section_end >= section_start),
  embedding extensions.vector(1536) not null,
  embedding_provider text not null check (length(embedding_provider) between 1 and 80),
  embedding_model text not null check (length(embedding_model) between 1 and 120),
  embedding_version text not null check (length(embedding_version) between 1 and 40),
  -- Lexical half of hybrid retrieval; kept in sync by Postgres itself.
  content_tsv tsvector generated always as (to_tsvector('english', content)) stored,
  created_at timestamptz not null default now(),
  constraint source_chunks_document_ordinal_unique unique (document_id, ordinal)
);

create index source_chunks_course_id_idx on public.source_chunks (course_id);
create index source_chunks_document_id_idx on public.source_chunks (document_id, ordinal);
-- HNSW over cosine distance: no training step (unlike IVFFlat), good recall
-- at MVP scale with default parameters (m=16, ef_construction=64). ADR-0013.
create index source_chunks_embedding_idx
  on public.source_chunks using hnsw (embedding extensions.vector_cosine_ops);
create index source_chunks_content_tsv_idx
  on public.source_chunks using gin (content_tsv);

alter table public.source_chunks enable row level security;
alter table public.source_chunks force row level security;

-- Owners may read their own chunks' text and metadata. All writes happen
-- through the worker (service role); clients have no write grants at all.
create policy source_chunks_select_own on public.source_chunks
  for select
  using (
    exists (
      select 1
      from public.courses c
      where c.id = source_chunks.course_id
        and c.user_id = (select auth.uid())
    )
  );

revoke all on table public.source_chunks from anon, authenticated;
-- Column-level select grant: the raw embedding vector (and the tsvector) are
-- deliberately NOT selectable by clients (spec U — embedding privacy).
grant select (
  id, document_id, course_id, concept_id, ordinal, content, token_estimate,
  source_locator, section_start, section_end,
  embedding_provider, embedding_model, embedding_version, created_at
) on table public.source_chunks to authenticated;

-- ---------------------------------------------------------------------------
-- atomic, idempotent chunk replacement (worker-only)
-- ---------------------------------------------------------------------------

create or replace function public.replace_source_chunks(
  p_document_id uuid,
  p_chunks jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_course_id uuid;
  inserted integer;
begin
  -- course_id is derived from the document, never trusted from the caller:
  -- a chunk can never be attributed to a different course than its document.
  select course_id into v_course_id from public.documents where id = p_document_id;
  if v_course_id is null then
    raise exception 'document % not found', p_document_id;
  end if;

  -- Delete + insert in one transaction: re-indexing (retry, provider change,
  -- re-extraction) always converges to exactly one active chunk set.
  delete from public.source_chunks where document_id = p_document_id;

  insert into public.source_chunks
    (document_id, course_id, ordinal, content, token_estimate, source_locator,
     section_start, section_end, embedding,
     embedding_provider, embedding_model, embedding_version)
  select
    p_document_id,
    v_course_id,
    (c ->> 'ordinal')::integer,
    c ->> 'content',
    (c ->> 'token_estimate')::integer,
    c -> 'source_locator',
    (c ->> 'section_start')::integer,
    (c ->> 'section_end')::integer,
    (c ->> 'embedding')::extensions.vector,
    c ->> 'embedding_provider',
    c ->> 'embedding_model',
    c ->> 'embedding_version'
  from jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) as c;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

revoke all on function public.replace_source_chunks(uuid, jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- course-scoped hybrid retrieval (authorization enforced in the database)
-- ---------------------------------------------------------------------------

create or replace function public.search_course_chunks(
  p_course_id uuid,
  p_query text,
  p_query_embedding extensions.vector(1536),
  p_top_k integer default 8,
  p_min_similarity double precision default 0.0,
  p_document_id uuid default null
)
returns table (
  chunk_id uuid,
  document_id uuid,
  document_filename text,
  ordinal integer,
  content text,
  source_locator jsonb,
  similarity double precision,
  lexical_rank real,
  score double precision
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_limit integer := least(greatest(coalesce(p_top_k, 8), 1), 50);
  v_pool integer := greatest(v_limit * 4, 20);
begin
  -- CRITICAL (spec K/T): course scoping happens HERE, for every caller with a
  -- user JWT. The service role (no JWT) is the trusted backend path.
  if (select auth.uid()) is not null then
    if not exists (
      select 1 from public.courses c
      where c.id = p_course_id and c.user_id = (select auth.uid())
    ) then
      raise exception 'course not found or not accessible';
    end if;
  end if;

  return query
  with vector_hits as (
    select v.id, v.sim,
           row_number() over (order by v.sim desc) as vrank
    from (
      select sc.id, 1 - (sc.embedding <=> p_query_embedding) as sim
      from public.source_chunks sc
      where sc.course_id = p_course_id
        and (p_document_id is null or sc.document_id = p_document_id)
      order by sc.embedding <=> p_query_embedding
      limit v_pool
    ) v
  ),
  lexical_hits as (
    select l.id, l.lex,
           row_number() over (order by l.lex desc) as lrank
    from (
      select sc.id, ts_rank(sc.content_tsv, q.tsq) as lex
      from public.source_chunks sc,
           (select websearch_to_tsquery('english', coalesce(p_query, '')) as tsq) q
      where sc.course_id = p_course_id
        and (p_document_id is null or sc.document_id = p_document_id)
        and q.tsq is not null
        and sc.content_tsv @@ q.tsq
      order by lex desc
      limit v_pool
    ) l
  ),
  fused as (
    -- Reciprocal-rank fusion (k = 60): exact nursing terminology (FEV1, DKA,
    -- furosemide…) surfaces through the lexical leg even when the embedding
    -- neighborhood is weak, and vice versa. ADR-0013.
    select coalesce(vh.id, lh.id) as id,
           vh.sim,
           lh.lex,
           coalesce(1.0 / (60 + vh.vrank), 0) + coalesce(1.0 / (60 + lh.lrank), 0) as rrf
    from vector_hits vh
    full outer join lexical_hits lh on lh.id = vh.id
  )
  select
    sc.id,
    sc.document_id,
    d.original_filename,
    sc.ordinal,
    sc.content,
    sc.source_locator,
    coalesce(f.sim, 0)::double precision,
    coalesce(f.lex, 0)::real,
    f.rrf::double precision
  from fused f
  join public.source_chunks sc on sc.id = f.id
  join public.documents d on d.id = sc.document_id
  where coalesce(f.sim, 0) >= p_min_similarity or f.lex is not null
  order by f.rrf desc, coalesce(f.sim, 0) desc
  limit v_limit;
end;
$$;

-- Owners (via their own JWT) and the backend may search; anonymous may not.
revoke all on function
  public.search_course_chunks(uuid, text, extensions.vector, integer, double precision, uuid)
  from public, anon;
grant execute on function
  public.search_course_chunks(uuid, text, extensions.vector, integer, double precision, uuid)
  to authenticated;
