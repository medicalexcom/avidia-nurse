-- M14: subscriptions, entitlements and production hardening (spec A–D, F/G,
-- K, O/P, W/X/Y/Z, AE, AK/AL; ADR-0036..0039).
--
-- Core principles enforced by this schema:
--   * PAYMENTS ARE NEVER CLIENT-AUTHORITATIVE. Clients can only SELECT their
--     own subscription rows; every write path is service_role-only (the
--     Stripe webhook edge function / store-billing backend). Entitlement
--     decisions come from get_my_entitlements(), computed server-side.
--   * LEARNING DATA NEVER DISAPPEARS ON EXPIRY (spec O). Nothing here
--     deletes or hides courses/mastery/etc. when a subscription lapses —
--     expiry only changes what current_plan() returns, which gates premium
--     capabilities and FREE-plan limits going FORWARD.
--   * ENFORCEMENT IS FEATURE-FLAG-GATED (spec AE). The 'subscriptions' flag
--     ships DISABLED: all limit triggers below no-op until it is flipped, so
--     current behavior (and the whole M0–M13 test suite) is unchanged until
--     billing is deliberately launched. Usage COUNTERS are recorded even
--     while enforcement is off — cost visibility (spec W/X) does not wait
--     for monetization.
--
-- Plan model (spec A/B, mirrored in @avidia/entitlements — rules_version 1):
--   free: 1 active course; 10 documents_processed / 30 ai_generations /
--         3 simulations per UTC month; no advanced_modes, no study_planner.
--   pro:  everything unlimited.
--   The numeric limits are engineering placeholders pending founder pricing
--   approval (Blueprint pricing is explicitly labeled hypotheses).

-- ---------------------------------------------------------------------------
-- feature_flags (spec AE)
-- ---------------------------------------------------------------------------

create table public.feature_flags (
  key text primary key check (length(key) between 1 and 64),
  enabled boolean not null default false,
  description text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.feature_flags enable row level security;

-- Everyone authenticated may READ flags (the client needs to know whether
-- billing enforcement is live to render paywalls); nobody but service_role
-- writes them.
create policy feature_flags_select on public.feature_flags
  for select to authenticated using (true);

revoke all on table public.feature_flags from public, anon;
grant select on table public.feature_flags to authenticated;

insert into public.feature_flags (key, enabled, description) values
  ('subscriptions', false,
   'Master switch for billing enforcement (M14). While false, usage is recorded but no plan limits or premium gates are enforced.');

create or replace function public.flag_enabled(flag_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select enabled from public.feature_flags where key = flag_key), false);
$$;

revoke all on function public.flag_enabled(text) from public, anon;
grant execute on function public.flag_enabled(text) to authenticated;

-- ---------------------------------------------------------------------------
-- subscriptions (spec C/D) — the normalized, provider-agnostic snapshot
-- ---------------------------------------------------------------------------

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null check (provider in ('stripe', 'apple', 'google')),
  provider_customer_id text not null check (length(provider_customer_id) between 1 and 255),
  provider_subscription_id text not null check (length(provider_subscription_id) between 1 and 255),
  product_id text check (product_id is null or length(product_id) between 1 and 255),
  plan text not null default 'pro' check (plan in ('pro')),
  -- The five normalized statuses (spec D); providers' raw vocabulary is
  -- mapped in @avidia/entitlements before it ever reaches this table.
  status text not null check (status in ('active', 'trialing', 'past_due', 'canceled', 'expired')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  trial_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Webhook upserts are keyed by the provider's subscription identity.
  constraint subscriptions_provider_subscription_key unique (provider, provider_subscription_id)
);

create index subscriptions_user_idx on public.subscriptions (user_id, status);

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

alter table public.subscriptions enable row level security;

-- Read-own ONLY. There are deliberately NO insert/update/delete policies for
-- authenticated: a client can never write its own subscription state (the
-- forged-premium attack in spec AP). service_role bypasses RLS.
create policy subscriptions_select_own on public.subscriptions
  for select to authenticated using (user_id = auth.uid());

revoke all on table public.subscriptions from public, anon;
grant select on table public.subscriptions to authenticated;

-- ---------------------------------------------------------------------------
-- billing_events (spec G) — webhook idempotency ledger
-- ---------------------------------------------------------------------------

create table public.billing_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe', 'apple', 'google')),
  provider_event_id text not null check (length(provider_event_id) between 1 and 255),
  event_type text not null check (length(event_type) between 1 and 128),
  -- Which user the event resolved to, when known. No payload bodies are
  -- stored here — no card data, no PII beyond the provider identifiers.
  user_id uuid references public.profiles (id) on delete set null,
  processed_at timestamptz not null default now(),
  -- Duplicate deliveries hit this index and are acknowledged without
  -- reprocessing (tested at the pure level in @avidia/entitlements).
  constraint billing_events_provider_event_key unique (provider, provider_event_id)
);

alter table public.billing_events enable row level security;
-- No client access at all: this is webhook infrastructure.
revoke all on table public.billing_events from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- usage_counters (spec W/X) — server-side monthly usage, always recorded
-- ---------------------------------------------------------------------------

create table public.usage_counters (
  user_id uuid not null references public.profiles (id) on delete cascade,
  resource text not null check (resource in ('documents_processed', 'ai_generations', 'simulations')),
  -- UTC month bucket, e.g. '2026-08' (matches monthlyPeriodKey in
  -- @avidia/entitlements).
  period_key text not null check (period_key ~ '^\d{4}-\d{2}$'),
  used integer not null default 0 check (used >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, resource, period_key)
);

alter table public.usage_counters enable row level security;

-- Students may see their own usage (the paywall shows "7/10 documents this
-- month"); only definer functions / service_role write it.
create policy usage_counters_select_own on public.usage_counters
  for select to authenticated using (user_id = auth.uid());

revoke all on table public.usage_counters from public, anon;
grant select on table public.usage_counters to authenticated;

create or replace function public.usage_period_key(at_time timestamptz default now())
returns text
language sql
immutable
as $$
  select to_char(at_time at time zone 'UTC', 'YYYY-MM');
$$;

revoke all on function public.usage_period_key(timestamptz) from public, anon;
grant execute on function public.usage_period_key(timestamptz) to authenticated;

-- Internal: bump a counter. SECURITY DEFINER so triggers running as the
-- inserting user may write the (RLS-protected) counters table; not
-- executable by clients directly.
create or replace function public.record_usage(p_user_id uuid, p_resource text, p_amount integer default 1)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_amount <= 0 then
    return;
  end if;
  insert into public.usage_counters as uc (user_id, resource, period_key, used)
  values (p_user_id, p_resource, public.usage_period_key(), p_amount)
  on conflict (user_id, resource, period_key)
  do update set used = uc.used + excluded.used, updated_at = now();
end;
$$;

revoke all on function public.record_usage(uuid, text, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- rate_limit_hits (spec Y) — sliding-window rate limiting for costly writes
-- ---------------------------------------------------------------------------

create table public.rate_limit_hits (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  bucket text not null check (length(bucket) between 1 and 64),
  created_at timestamptz not null default now()
);

create index rate_limit_hits_lookup_idx
  on public.rate_limit_hits (user_id, bucket, created_at desc);

alter table public.rate_limit_hits enable row level security;
revoke all on table public.rate_limit_hits from public, anon, authenticated;

-- Returns true when the caller is INSIDE the limit (and records the hit).
-- Rate limiting protects costly pipelines (uploads, simulations) — ordinary
-- studying (reviews, answers) is deliberately NOT rate limited (spec Y).
create or replace function public.check_rate_limit(
  p_user_id uuid,
  p_bucket text,
  p_max_hits integer,
  p_window interval
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  hit_count integer;
begin
  select count(*) into hit_count
  from public.rate_limit_hits
  where user_id = p_user_id
    and bucket = p_bucket
    and created_at > now() - p_window;
  if hit_count >= p_max_hits then
    return false;
  end if;
  insert into public.rate_limit_hits (user_id, bucket) values (p_user_id, p_bucket);
  -- Opportunistic cleanup keeps the table bounded without a cron.
  delete from public.rate_limit_hits
  where user_id = p_user_id and bucket = p_bucket and created_at < now() - p_window * 2;
  return true;
end;
$$;

revoke all on function public.check_rate_limit(uuid, text, integer, interval) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- current_plan (spec J/P) — the server-side mirror of grantsPaidAccess
-- ---------------------------------------------------------------------------

-- PRO when ANY provider row grants paid access right now:
--   active/trialing .. through current_period_end (null end trusts status),
--   past_due ......... bounded 7-day grace past period end (case AY-F),
--   canceled ......... through the already-paid period end (case AY-E),
--   expired .......... never.
create or replace function public.current_plan(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when exists (
    select 1 from public.subscriptions s
    where s.user_id = p_user_id
      and (
        (s.status in ('active', 'trialing')
          and (s.current_period_end is null or s.current_period_end > now()))
        or (s.status = 'past_due'
          and s.current_period_end is not null
          and s.current_period_end + interval '7 days' > now())
        or (s.status = 'canceled'
          and s.current_period_end is not null
          and s.current_period_end > now())
      )
  ) then 'pro' else 'free' end;
$$;

revoke all on function public.current_plan(uuid) from public, anon;
grant execute on function public.current_plan(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- get_my_entitlements (spec K) — THE authoritative entitlement read
-- ---------------------------------------------------------------------------

create or replace function public.get_my_entitlements()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  plan text;
  enforced boolean;
  period text := public.usage_period_key();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  plan := public.current_plan(uid);
  enforced := public.flag_enabled('subscriptions');
  return jsonb_build_object(
    'rules_version', 1,
    'plan', plan,
    'enforced', enforced,
    'capabilities', case when plan = 'pro'
      then jsonb_build_array('course_uploads', 'adaptive_study', 'advanced_modes',
                             'patient_simulation', 'analytics', 'study_planner', 'ai_generation')
      else jsonb_build_array('course_uploads', 'adaptive_study', 'patient_simulation',
                             'analytics', 'ai_generation')
    end,
    'limits', case when plan = 'pro'
      then jsonb_build_object('max_active_courses', null,
        'monthly', jsonb_build_object('documents_processed', null, 'ai_generations', null, 'simulations', null))
      else jsonb_build_object('max_active_courses', 1,
        'monthly', jsonb_build_object('documents_processed', 10, 'ai_generations', 30, 'simulations', 3))
    end,
    'usage', coalesce((
      select jsonb_object_agg(resource, used)
      from public.usage_counters
      where user_id = uid and period_key = period
    ), '{}'::jsonb),
    'period_key', period,
    'subscriptions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', provider,
        'status', status,
        'current_period_end', current_period_end,
        'cancel_at_period_end', cancel_at_period_end,
        'trial_end', trial_end
      ) order by updated_at desc)
      from public.subscriptions where user_id = uid
    ), '[]'::jsonb),
    'fetched_at', now()
  );
end;
$$;

revoke all on function public.get_my_entitlements() from public, anon;
grant execute on function public.get_my_entitlements() to authenticated;

-- ---------------------------------------------------------------------------
-- Flag-gated FREE-plan limit triggers (spec B/N/Y — enforced server-side)
-- ---------------------------------------------------------------------------

-- Courses: FREE keeps ONE active course (archived courses don't count and
-- remain fully readable — data preservation, spec O).
create or replace function public.enforce_course_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.flag_enabled('subscriptions') then
    return new;
  end if;
  if new.status = 'active'
     and public.current_plan(new.user_id) = 'free'
     and (select count(*) from public.courses
          where user_id = new.user_id and status = 'active'
            and (tg_op = 'INSERT' or id <> new.id)) >= 1 then
    raise exception 'PLAN_LIMIT: free plan allows 1 active course — archive a course or upgrade to PRO'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger courses_enforce_plan_limit
  before insert or update of status on public.courses
  for each row execute function public.enforce_course_limit();

-- Documents: rate limit (30/hour, abuse control — spec Y) plus the FREE
-- monthly documents_processed limit. Usage is recorded ALWAYS (spec X).
create or replace function public.enforce_document_limits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.flag_enabled('subscriptions') then
    if not public.check_rate_limit(new.uploaded_by, 'document_upload', 30, interval '1 hour') then
      raise exception 'RATE_LIMIT: too many uploads — please wait a bit and try again'
        using errcode = 'P0001';
    end if;
    if public.current_plan(new.uploaded_by) = 'free'
       and coalesce((select used from public.usage_counters
                     where user_id = new.uploaded_by
                       and resource = 'documents_processed'
                       and period_key = public.usage_period_key()), 0) >= 10 then
      raise exception 'PLAN_LIMIT: free plan monthly document limit reached — upgrade to PRO for unlimited uploads'
        using errcode = 'P0001';
    end if;
  end if;
  perform public.record_usage(new.uploaded_by, 'documents_processed', 1);
  return new;
end;
$$;

create trigger documents_enforce_plan_limits
  before insert on public.documents
  for each row execute function public.enforce_document_limits();

-- Simulations: rate limit plus the FREE monthly simulations limit.
create or replace function public.enforce_simulation_limits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.flag_enabled('subscriptions') then
    if not public.check_rate_limit(new.user_id, 'simulation_start', 20, interval '1 hour') then
      raise exception 'RATE_LIMIT: too many simulation starts — please wait a bit and try again'
        using errcode = 'P0001';
    end if;
    if public.current_plan(new.user_id) = 'free'
       and coalesce((select used from public.usage_counters
                     where user_id = new.user_id
                       and resource = 'simulations'
                       and period_key = public.usage_period_key()), 0) >= 3 then
      raise exception 'PLAN_LIMIT: free plan monthly simulation limit reached — upgrade to PRO for unlimited simulations'
        using errcode = 'P0001';
    end if;
  end if;
  perform public.record_usage(new.user_id, 'simulations', 1);
  return new;
end;
$$;

create trigger simulation_sessions_enforce_plan_limits
  before insert on public.simulation_sessions
  for each row execute function public.enforce_simulation_limits();

-- AI generations: the worker (service_role) flips documents.question_status
-- pending → generating exactly once per paid generation run (the fingerprint
-- skip never reaches 'generating' twice for unchanged material). Recording
-- here gives cost telemetry per user WITHOUT touching the stable worker
-- code. This trigger only records — generation limits for FREE act at the
-- upload gate above, so a document already accepted is always fully
-- processed (no half-broken courses).
create or replace function public.record_ai_generation_usage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.question_status = 'generating' and old.question_status = 'pending' then
    perform public.record_usage(new.uploaded_by, 'ai_generations', 1);
  end if;
  return new;
end;
$$;

create trigger documents_record_ai_generation_usage
  before update of question_status on public.documents
  for each row execute function public.record_ai_generation_usage();

-- ---------------------------------------------------------------------------
-- export_my_data (spec AK) — user-initiated data export
-- ---------------------------------------------------------------------------

create or replace function public.export_my_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  return jsonb_build_object(
    'exported_at', now(),
    'format_version', 1,
    'profile', (select to_jsonb(p) - 'id' from public.profiles p where p.id = uid),
    'courses', coalesce((select jsonb_agg(to_jsonb(c)) from public.courses c where c.user_id = uid), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'course_id', d.course_id, 'original_filename', d.original_filename,
        'mime_type', d.mime_type, 'created_at', d.created_at))
      from public.documents d where d.uploaded_by = uid), '[]'::jsonb),
    'mastery', coalesce((
      select jsonb_agg(to_jsonb(m)) from public.concept_mastery m where m.user_id = uid), '[]'::jsonb),
    'study_sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'course_id', s.course_id, 'status', s.status,
        'started_at', s.started_at, 'completed_at', s.completed_at))
      from public.study_sessions s
      join public.courses c on c.id = s.course_id
      where c.user_id = uid), '[]'::jsonb),
    'simulation_sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ss.id, 'case_id', ss.case_id, 'status', ss.status,
        'started_at', ss.started_at, 'completed_at', ss.completed_at))
      from public.simulation_sessions ss where ss.user_id = uid), '[]'::jsonb),
    'study_plans', coalesce((
      select jsonb_agg(to_jsonb(sp)) from public.study_plans sp where sp.user_id = uid), '[]'::jsonb),
    'usage', coalesce((
      select jsonb_agg(to_jsonb(u)) from public.usage_counters u where u.user_id = uid), '[]'::jsonb),
    'subscriptions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', s.provider, 'status', s.status, 'plan', s.plan,
        'current_period_end', s.current_period_end, 'created_at', s.created_at))
      from public.subscriptions s where s.user_id = uid), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;

-- ---------------------------------------------------------------------------
-- delete_my_account (spec AL) — full account deletion with billing guard
-- ---------------------------------------------------------------------------

-- Billing implication (documented in ADR-0039 / M14 worklog): deleting the
-- account does NOT cancel a provider subscription by itself, so we refuse
-- while a web subscription would keep charging. Store subscriptions are
-- managed in the platform's own UI and cannot charge a deleted app account
-- into confusion the same way, but the same guard applies for symmetry.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if exists (
    select 1 from public.subscriptions
    where user_id = uid
      and status in ('active', 'trialing', 'past_due')
      and not cancel_at_period_end
  ) then
    raise exception 'ACTIVE_SUBSCRIPTION: cancel your subscription before deleting your account'
      using errcode = 'P0001';
  end if;
  -- Remove the user's private storage objects (path convention: first
  -- segment is the owner's uid — enforced by 0003's storage policies).
  delete from storage.objects
  where bucket_id = 'course-materials'
    and (storage.foldername(name))[1] = uid::text;
  -- auth.users cascades to profiles, which cascades through every
  -- user-owned table (0001+). Nothing user-owned survives.
  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
