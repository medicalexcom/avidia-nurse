-- M3: course-material documents and private storage (Playbook §6 data model,
-- §9 ingestion pipeline steps 1–3; ADR-0008).
--
-- Scope note: M3 covers UPLOAD, STORAGE, METADATA, OWNERSHIP, STATUS and
-- SECURITY only. No extraction, embeddings or AI processing happens yet, so a
-- successfully stored document rests at processing_status = 'uploaded'. The
-- later states ('queued', 'processing', 'ready') are reserved for the M4
-- worker and are legal values today so M4 needs no schema change.
--
-- Ownership model:
--   * documents belong to exactly one course; the caller must own that course
--     (same exists-course-owner pattern as modules/exams in 0002).
--   * uploaded_by must be the caller; neither course_id nor uploaded_by is
--     updatable (column grants), so documents can never be reparented.
--
-- Storage model:
--   * private bucket "course-materials" (public = false). Nothing in it is
--     ever publicly reachable; reads use short-lived signed URLs generated on
--     demand and never persisted.
--   * object path convention: {user_id}/{course_id}/{document_id}/{filename}.
--     The FIRST path segment is the owner's auth.uid, and storage policies
--     enforce it — the path is predictable, but authorization comes from the
--     policies, not from path obscurity.
--   * a CHECK constraint ties documents.storage_key to that same convention,
--     so a row can only ever reference an object inside its owner's folder.

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  uploaded_by uuid not null references public.profiles (id) on delete cascade,
  -- Sanitized name used in the storage key; original_filename preserves what
  -- the student actually picked, for display.
  filename text not null check (length(btrim(filename)) between 1 and 160),
  original_filename text not null check (length(btrim(original_filename)) between 1 and 255),
  mime_type text not null check (length(mime_type) between 1 and 160),
  file_extension text not null check (file_extension in ('pdf', 'pptx', 'docx', 'txt')),
  -- 50 MiB hard safety cap; the app-level configurable limit (and the bucket
  -- limit) must stay at or below this. See ADR-0008 for the rationale.
  file_size bigint not null check (file_size > 0 and file_size <= 52428800),
  -- Null while the object upload is still in flight ('uploading'/'failed');
  -- required once the document is storage-complete.
  storage_key text null,
  document_type text not null default 'other' check (
    document_type in ('lecture', 'study_guide', 'course_objectives', 'notes', 'textbook_excerpt', 'other')
  ),
  processing_status text not null default 'uploading' check (
    processing_status in ('uploading', 'uploaded', 'queued', 'processing', 'ready', 'failed')
  ),
  error_message text null check (error_message is null or length(error_message) <= 500),
  -- SHA-256 hex of the file contents, when the platform could compute it
  -- (web today; native deferred — ADR-0008). Used for duplicate detection.
  content_hash text null check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A storage-complete document must have its object recorded.
  constraint documents_storage_key_when_stored check (
    processing_status in ('uploading', 'failed') or storage_key is not null
  ),
  -- The storage key may only point inside this owner's folder for this course
  -- and this document: {uploaded_by}/{course_id}/{id}/...
  constraint documents_storage_key_matches_owner check (
    storage_key is null
    or storage_key like (uploaded_by::text || '/' || course_id::text || '/' || id::text || '/%')
  )
);

create index documents_course_id_created_at_idx on public.documents (course_id, created_at desc);
create index documents_course_id_content_hash_idx on public.documents (course_id, content_hash)
  where content_hash is not null;
create index documents_uploaded_by_idx on public.documents (uploaded_by);

alter table public.documents enable row level security;
alter table public.documents force row level security;

-- Visible/writable only when the parent course belongs to the caller. INSERT
-- additionally requires uploaded_by = caller, so a student cannot attribute
-- an upload to someone else even inside their own course.
create policy documents_select_own on public.documents
  for select
  using (
    exists (
      select 1 from public.courses c
      where c.id = documents.course_id and c.user_id = (select auth.uid())
    )
  );

create policy documents_insert_own on public.documents
  for insert
  with check (
    uploaded_by = (select auth.uid())
    and exists (
      select 1 from public.courses c
      where c.id = documents.course_id and c.user_id = (select auth.uid())
    )
  );

create policy documents_update_own on public.documents
  for update
  using (
    exists (
      select 1 from public.courses c
      where c.id = documents.course_id and c.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = documents.course_id and c.user_id = (select auth.uid())
    )
  );

create policy documents_delete_own on public.documents
  for delete
  using (
    exists (
      select 1 from public.courses c
      where c.id = documents.course_id and c.user_id = (select auth.uid())
    )
  );

revoke all on table public.documents from anon, authenticated;
grant select, delete on table public.documents to authenticated;
-- course_id / uploaded_by are insert-only: documents cannot be reparented or
-- re-attributed. File identity columns are also insert-only; a "replace" is a
-- delete + new upload.
grant insert (
  course_id, uploaded_by, filename, original_filename, mime_type,
  file_extension, file_size, document_type, content_hash
) on table public.documents to authenticated;
-- Clients may finish/fail an upload and relabel the material. M4's worker
-- (service role) will manage queued/processing/ready transitions server-side.
grant update (storage_key, processing_status, error_message, document_type)
  on table public.documents to authenticated;

create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- storage: private course-materials bucket + object policies
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'course-materials',
  'course-materials',
  false, -- PRIVATE: student materials are never publicly accessible.
  52428800, -- 50 MiB, mirrors the documents.file_size cap.
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain'
  ]
)
on conflict (id) do nothing;

-- storage.objects already has RLS enabled by Supabase. These policies scope
-- every operation to the caller's own top-level folder ({user_id}/...), and
-- INSERT additionally requires the second segment to be a course the caller
-- owns. There is no UPDATE policy: objects cannot be replaced in place.
create policy course_materials_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'course-materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy course_materials_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'course-materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.courses c
      where c.id::text = (storage.foldername(name))[2]
        and c.user_id = (select auth.uid())
    )
  );

create policy course_materials_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'course-materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
