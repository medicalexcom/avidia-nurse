-- M1: user profile foundation (Playbook §6 "User" entity, §7 schema, §8 RLS).
--
-- Supabase manages identities in auth.users. The application profile lives in
-- public.profiles, 1:1 with auth.users, created automatically by trigger on
-- sign-up. Students can read their own profile and update only timezone and
-- program_type. No client may insert, delete, or touch another user's row.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text unique not null,
  role text not null default 'student',
  timezone text,
  program_type text check (program_type in ('absn', 'bsn', 'adn', 'other')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Student profile, 1:1 with auth.users. Playbook §7 users table; named profiles to avoid shadowing auth.users.';

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.profiles force row level security;

-- A user can read only their own profile.
create policy profiles_select_own on public.profiles
  for select
  using ((select auth.uid()) = id);

-- A user can update only their own profile row. Which COLUMNS they may change
-- is restricted separately via column-level grants below.
create policy profiles_update_own on public.profiles
  for update
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- No insert/delete policies: clients cannot create or remove profiles.
-- Profiles are created by the on_auth_user_created trigger (definer rights).

-- ---------------------------------------------------------------------------
-- Column-level grants: students may change ONLY timezone and program_type.
-- ---------------------------------------------------------------------------
revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (timezone, program_type) on table public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Automatic profile creation on sign-up
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Keep updated_at accurate
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();
