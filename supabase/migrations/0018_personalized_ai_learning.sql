-- Personalized, source-grounded learning artifacts and contextual tutor.
-- AI authors content asynchronously; deterministic scoring/mastery and the
-- M11 simulation interpreter remain unchanged.

create table public.ai_learning_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  kind text not null check (kind in ('case_study','simulation','tutor')),
  status text not null default 'queued' check (status in ('queued','processing','ready','failed')),
  request jsonb not null default '{}'::jsonb,
  result jsonb,
  error_message text,
  fingerprint text,
  attempts integer not null default 0 check (attempts between 0 and 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index ai_learning_requests_queue_idx on public.ai_learning_requests(status, created_at);
create unique index ai_learning_requests_owner_fingerprint_idx
  on public.ai_learning_requests(user_id, kind, fingerprint)
  where fingerprint is not null and status = 'ready';
create trigger ai_learning_requests_updated_at before update on public.ai_learning_requests
  for each row execute function public.set_updated_at();
alter table public.ai_learning_requests enable row level security;
alter table public.ai_learning_requests force row level security;
create policy ai_learning_requests_select_own on public.ai_learning_requests for select
  using (user_id = (select auth.uid()) and exists (
    select 1 from public.courses c where c.id = course_id and c.user_id = (select auth.uid())
  ));
create policy ai_learning_requests_insert_own on public.ai_learning_requests for insert
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.courses c where c.id = course_id and c.user_id = (select auth.uid())
  ));
revoke all on public.ai_learning_requests from anon, authenticated;
grant select on public.ai_learning_requests to authenticated;
grant insert(user_id, course_id, kind, request, fingerprint) on public.ai_learning_requests to authenticated;

create table public.generated_case_studies (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.ai_learning_requests(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  title text not null,
  difficulty text not null check (difficulty in ('foundational','application','advanced','complex')),
  grounding text not null check (grounding in ('course_grounded','general_nursing_knowledge')),
  content jsonb not null,
  concept_ids uuid[] not null default '{}',
  source_chunk_ids uuid[] not null default '{}',
  provider text not null,
  model text not null,
  model_tier text not null check (model_tier in ('STANDARD','ADVANCED')),
  prompt_version text not null,
  generator_version text not null,
  validator_version text not null,
  fingerprint text not null,
  status text not null default 'active' check (status in ('active','retired')),
  created_at timestamptz not null default now(),
  unique(user_id, fingerprint)
);
alter table public.generated_case_studies enable row level security;
alter table public.generated_case_studies force row level security;
create policy generated_case_studies_select_own on public.generated_case_studies for select
  using (user_id = (select auth.uid()) and exists (
    select 1 from public.courses c where c.id = course_id and c.user_id = (select auth.uid())
  ));
revoke all on public.generated_case_studies from anon, authenticated;
grant select on public.generated_case_studies to authenticated;

create table public.tutor_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  title text not null default 'Ask Avidia',
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger tutor_conversations_updated_at before update on public.tutor_conversations
  for each row execute function public.set_updated_at();
alter table public.tutor_conversations enable row level security;
alter table public.tutor_conversations force row level security;
create policy tutor_conversations_own on public.tutor_conversations for all
  using (user_id = (select auth.uid())) with check (
    user_id = (select auth.uid()) and exists (
      select 1 from public.courses c where c.id = course_id and c.user_id = (select auth.uid())
    )
  );
revoke all on public.tutor_conversations from anon, authenticated;
grant select, delete on public.tutor_conversations to authenticated;
grant insert(user_id, course_id, title, context) on public.tutor_conversations to authenticated;
grant update(title, context) on public.tutor_conversations to authenticated;

create table public.tutor_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.tutor_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null check (length(content) between 1 and 12000),
  source_chunk_ids uuid[] not null default '{}',
  task text,
  model_tier text,
  created_at timestamptz not null default now()
);
create index tutor_messages_conversation_idx on public.tutor_messages(conversation_id, created_at);
alter table public.tutor_messages enable row level security;
alter table public.tutor_messages force row level security;
create policy tutor_messages_select_own on public.tutor_messages for select using (
  user_id = (select auth.uid()) and exists (
    select 1 from public.tutor_conversations tc
    where tc.id = conversation_id and tc.user_id = (select auth.uid())
  )
);
create policy tutor_messages_insert_user on public.tutor_messages for insert with check (
  user_id = (select auth.uid()) and role = 'user' and exists (
    select 1 from public.tutor_conversations tc
    where tc.id = conversation_id and tc.user_id = (select auth.uid())
  )
);
revoke all on public.tutor_messages from anon, authenticated;
grant select on public.tutor_messages to authenticated;
grant insert(conversation_id, user_id, role, content) on public.tutor_messages to authenticated;

-- Generated simulation definitions use the existing simulation_cases table
-- and therefore run through the unchanged deterministic M11 interpreter.
alter table public.simulation_cases add column owner_id uuid references auth.users(id) on delete cascade;
alter table public.simulation_cases add column course_id uuid references public.courses(id) on delete cascade;
alter table public.simulation_cases add column generation_metadata jsonb;
alter table public.simulation_cases add constraint simulation_cases_generated_ownership check (
  (owner_id is null and course_id is null) or (owner_id is not null and course_id is not null)
);
drop policy simulation_cases_select_active on public.simulation_cases;
create policy simulation_cases_select_active on public.simulation_cases for select using (
  status = 'active' and (
    owner_id is null or (owner_id = (select auth.uid()) and exists (
      select 1 from public.courses c where c.id = course_id and c.user_id = (select auth.uid())
    ))
  )
);
grant select(owner_id, course_id, generation_metadata) on public.simulation_cases to authenticated;

-- Replace only the start entry point to add generated-case ownership/course
-- authorization. All state transitions, scoring, events and evidence remain
-- in the unchanged M11 functions.
create or replace function public.start_simulation(p_course_id uuid, p_case_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := (select auth.uid());
  v_case public.simulation_cases%rowtype;
  v_session public.simulation_sessions%rowtype;
  v_state jsonb;
begin
  if v_user_id is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.courses c where c.id=p_course_id and c.user_id=v_user_id)
    then raise exception 'course not found'; end if;
  select * into v_case from public.simulation_cases where case_key=p_case_key and status='active'
    and (owner_id is null or (owner_id=v_user_id and course_id=p_course_id));
  if v_case.id is null then raise exception 'simulation case not found'; end if;
  if v_case.engine_version <> 1 then raise exception 'simulation engine version mismatch'; end if;
  select * into v_session from public.simulation_sessions where user_id=v_user_id
    and course_id=p_course_id and case_id=v_case.id and status='active'
    order by started_at desc limit 1;
  if v_session.id is not null then return jsonb_build_object('session_id',v_session.id,
    'resumed',true,'status',v_session.status,'view',public.sim_client_view(v_session.definition,v_session.state)); end if;
  v_state := public.sim_start_state(v_case.definition);
  insert into public.simulation_sessions(user_id,course_id,case_id,case_version,engine_version,definition,state)
    values(v_user_id,p_course_id,v_case.id,v_case.case_version,v_case.engine_version,v_case.definition,v_state)
    returning * into v_session;
  return jsonb_build_object('session_id',v_session.id,'resumed',false,'status',v_session.status,
    'view',public.sim_client_view(v_case.definition,v_state));
end; $$;

-- Service-role worker atomically claims one request. Client roles cannot call it.
create or replace function public.claim_ai_learning_request() returns public.ai_learning_requests
language plpgsql security definer set search_path=public as $$
declare r public.ai_learning_requests%rowtype;
begin
  select * into r from public.ai_learning_requests where status='queued' and attempts < 3
    order by created_at for update skip locked limit 1;
  if r.id is null then return null; end if;
  update public.ai_learning_requests set status='processing', attempts=attempts+1 where id=r.id returning * into r;
  return r;
end; $$;
revoke all on function public.claim_ai_learning_request() from public, anon, authenticated;
