-- M4: document extraction and processing (Playbook §9 ingestion steps 4–5 and
-- 14, §19 M4 "PDF/PPTX/DOCX extraction, chunks, provenance, retry"; ADR-0009,
-- ADR-0010).
--
-- Scope note: M4 turns stored files into a normalized, provenance-preserving
-- structural representation (document_sections). Semantic chunking, embeddings
-- and pgvector (the Playbook's source_chunks table) are M5: source_chunks
-- requires the vector extension and is derived FROM these sections.
--
-- Processing model:
--   * The client may only move a document along its own legal transitions
--     (uploading→uploaded/failed, uploaded→queued, failed→uploading/queued).
--     A trigger enforces the state machine for everyone and reserves the
--     worker-only transitions (→processing, →ready) for the service role, so
--     a forged client can never mark its own document READY without the
--     extraction actually having run.
--   * The worker (service role, server-side only) claims QUEUED documents,
--     downloads the private object, extracts, and atomically replaces the
--     document's sections via replace_document_sections() — idempotent
--     rebuild: reprocessing can never duplicate content.
--   * Internal diagnostics go to processing_detail (service-role only);
--     error_message remains the user-facing, safe message.

-- ---------------------------------------------------------------------------
-- documents: processing bookkeeping columns
-- ---------------------------------------------------------------------------

alter table public.documents
  add column processed_at timestamptz null,
  add column processing_attempts integer not null default 0
    check (processing_attempts >= 0),
  -- Internal failure diagnostics (parser error names, stage markers). Never
  -- shown to users; intentionally absent from the authenticated update grant.
  add column processing_detail text null
    check (processing_detail is null or length(processing_detail) <= 2000);

-- ---------------------------------------------------------------------------
-- status state machine, enforced in the database
-- ---------------------------------------------------------------------------

create or replace function public.enforce_document_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.processing_status is distinct from old.processing_status then
    if not (
      (old.processing_status = 'uploading' and new.processing_status in ('uploaded', 'failed'))
      or (old.processing_status = 'uploaded' and new.processing_status = 'queued')
      or (old.processing_status = 'queued' and new.processing_status = 'processing')
      or (old.processing_status = 'processing' and new.processing_status in ('ready', 'failed'))
      or (old.processing_status = 'failed' and new.processing_status in ('uploading', 'queued'))
    ) then
      raise exception 'illegal document status transition from % to %',
        old.processing_status, new.processing_status;
    end if;

    -- Entering 'processing' or 'ready' is reserved for the processing worker
    -- (service role, which carries no user JWT). A signed-in client must not
    -- be able to fake a completed extraction.
    if new.processing_status in ('processing', 'ready') and (select auth.uid()) is not null then
      raise exception 'status % may only be set by the processing worker',
        new.processing_status;
    end if;
  end if;
  return new;
end;
$$;

create trigger documents_enforce_status_transition
  before update on public.documents
  for each row execute function public.enforce_document_status_transition();

-- ---------------------------------------------------------------------------
-- document_sections: normalized, provenance-preserving extracted content
-- ---------------------------------------------------------------------------

create table public.document_sections (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  section_type text not null check (
    section_type in (
      'heading', 'paragraph', 'list', 'table',
      'slide_title', 'slide_body', 'slide_notes', 'page_text'
    )
  ),
  -- Document order: 0-based, unique per document. This is the reading order
  -- M5 chunking must respect.
  sequence integer not null check (sequence >= 0),
  -- Source locators (Playbook §9 step 8): exactly where this content came
  -- from. Pages for PDFs, slides for PPTX; null for DOCX/TXT, whose locator
  -- is the sequence plus nearest heading.
  page_number integer null check (page_number is null or page_number > 0),
  slide_number integer null check (slide_number is null or slide_number > 0),
  -- Nearest enclosing heading / slide title, so provenance can read
  -- "Study Guide → section 'Postoperative Complications'".
  heading text null check (heading is null or length(heading) <= 500),
  content text not null check (length(content) between 1 and 20000),
  -- Parser-specific extras only (e.g. heading level, list item count, table
  -- dimensions). The relational columns above are the contract; metadata is
  -- never a substitute for them.
  metadata jsonb null,
  created_at timestamptz not null default now(),
  constraint document_sections_document_sequence_unique unique (document_id, sequence)
);

create index document_sections_document_id_idx
  on public.document_sections (document_id, sequence);

alter table public.document_sections enable row level security;
alter table public.document_sections force row level security;

-- Owners may read the extracted content of their own documents. All writes
-- happen through the worker (service role bypasses RLS); clients have no
-- insert/update/delete grant at all.
create policy document_sections_select_own on public.document_sections
  for select
  using (
    exists (
      select 1
      from public.documents d
      join public.courses c on c.id = d.course_id
      where d.id = document_sections.document_id
        and c.user_id = (select auth.uid())
    )
  );

revoke all on table public.document_sections from anon, authenticated;
grant select on table public.document_sections to authenticated;

-- ---------------------------------------------------------------------------
-- atomic, idempotent section replacement (worker-only)
-- ---------------------------------------------------------------------------

create or replace function public.replace_document_sections(
  p_document_id uuid,
  p_sections jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted integer;
begin
  -- Delete + insert in one transaction: reprocessing a document (retry,
  -- crashed worker, duplicate job) always converges to exactly one clean set
  -- of sections. No partial mixes of old and new extraction are observable.
  delete from public.document_sections where document_id = p_document_id;

  insert into public.document_sections
    (document_id, section_type, sequence, page_number, slide_number, heading, content, metadata)
  select
    p_document_id,
    s ->> 'section_type',
    (s ->> 'sequence')::integer,
    nullif(s ->> 'page_number', '')::integer,
    nullif(s ->> 'slide_number', '')::integer,
    nullif(s ->> 'heading', ''),
    s ->> 'content',
    case when jsonb_typeof(s -> 'metadata') = 'object' then s -> 'metadata' end
  from jsonb_array_elements(coalesce(p_sections, '[]'::jsonb)) as s;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

-- Worker-only: clients can neither write sections directly nor through this
-- function. (service_role retains execute via its default privileges.)
revoke all on function public.replace_document_sections(uuid, jsonb)
  from public, anon, authenticated;
