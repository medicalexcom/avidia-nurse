-- Ask Avidia live-fix follow-up: honest provenance labeling + tutor
-- request priority (course-first/general-knowledge-fallback policy; low-
-- latency tutor answers must not queue behind background case/simulation
-- authoring). Companion to apps/worker/src/learningGeneration.ts.
--
-- Scope note: this migration only (a) records which grounding mode an
-- assistant tutor reply actually used, (b) widens the existing
-- generated_case_studies.grounding vocabulary to include the same 'mixed'
-- state case_study/simulation authoring can now honestly report, and
-- (c) changes claim_ai_learning_request()'s ORDER BY so tutor-kind rows are
-- claimed before case_study/simulation rows of the same or earlier
-- created_at. It does not touch M11 runtime state, scoring, or any RLS
-- policy — cross-user isolation is unchanged.

-- ---------------------------------------------------------------------------
-- tutor_messages: deterministic per-reply grounding mode (spec: "Retrieved
-- ≠ supporting" — the client must render this instead of inferring
-- provenance from source_chunk_ids.length alone).
-- ---------------------------------------------------------------------------

alter table public.tutor_messages
  add column grounding text null check (
    grounding in ('course_grounded', 'mixed', 'general_knowledge')
  );

-- ---------------------------------------------------------------------------
-- generated_case_studies: allow the same three-mode vocabulary tutor replies
-- and simulations use. Existing rows keep their current (still-valid) value.
-- ---------------------------------------------------------------------------

alter table public.generated_case_studies
  drop constraint if exists generated_case_studies_grounding_check;

alter table public.generated_case_studies
  add constraint generated_case_studies_grounding_check
  check (grounding in ('course_grounded', 'mixed', 'general_nursing_knowledge'));

-- ---------------------------------------------------------------------------
-- claim_ai_learning_request(): tutor-kind rows claim before case_study /
-- simulation rows (both remain strict FIFO within their own priority band).
-- Everything else about the function — attempts<3, status='queued',
-- for update skip locked, the attempts increment — is unchanged from 0018.
-- ---------------------------------------------------------------------------

create or replace function public.claim_ai_learning_request()
returns public.ai_learning_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.ai_learning_requests%rowtype;
begin
  select * into r
  from public.ai_learning_requests
  where status = 'queued' and attempts < 3
  order by (kind <> 'tutor'), created_at
  for update skip locked
  limit 1;

  if r.id is null then
    return null;
  end if;

  update public.ai_learning_requests
  set status = 'processing', attempts = attempts + 1
  where id = r.id
  returning * into r;

  return r;
end;
$$;
