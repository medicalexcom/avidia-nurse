-- M2: courses, modules, exams (Playbook §6 data model).
--
-- Ownership model:
--   * courses belong directly to a user (user_id -> public.profiles).
--   * modules and exams belong to a course and inherit ownership through it.
--   * exam_modules is a normalized join table associating an exam with the
--     modules it covers; both sides must belong to the SAME course, which in
--     turn must belong to the caller.
--
-- Security model (same discipline as 0001 / ADR-0006):
--   * RLS enabled AND forced on every table; policies scope every operation
--     to rows the caller owns (directly or through the parent course).
--   * Column-level grants restrict which fields a client may write, so
--     ownership columns (user_id, course_id) can never be reassigned.
--   * Deletion is explicit and cascading: deleting a course deletes its
--     modules and exams; deleting a module or exam deletes its join rows.
--     Deleting course data NEVER touches public.profiles (the FK cascades
--     point away from profiles, not toward it).
--
-- Timestamps: all timestamptz, stored in UTC (ADR-0007). Clients convert for
-- display using the student's profile timezone.

-- ---------------------------------------------------------------------------
-- courses
-- ---------------------------------------------------------------------------

create table public.courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 120),
  term text null check (term is null or length(term) <= 60),
  institution_name text null check (institution_name is null or length(institution_name) <= 120),
  -- Soft archive for normal course retirement; hard delete stays available
  -- behind an explicit confirmation in the UI.
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index courses_user_id_idx on public.courses (user_id);

alter table public.courses enable row level security;
alter table public.courses force row level security;

create policy courses_select_own on public.courses
  for select
  using ((select auth.uid()) = user_id);

create policy courses_insert_own on public.courses
  for insert
  with check ((select auth.uid()) = user_id);

create policy courses_update_own on public.courses
  for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy courses_delete_own on public.courses
  for delete
  using ((select auth.uid()) = user_id);

revoke all on table public.courses from anon, authenticated;
grant select, delete on table public.courses to authenticated;
grant insert (user_id, title, term, institution_name, status) on table public.courses to authenticated;
-- user_id is deliberately NOT updatable: courses cannot change owners.
grant update (title, term, institution_name, status) on table public.courses to authenticated;

create trigger courses_set_updated_at
  before update on public.courses
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- modules (ownership inherited through the course)
-- ---------------------------------------------------------------------------

create table public.modules (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 120),
  sequence integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index modules_course_id_sequence_idx on public.modules (course_id, sequence);

alter table public.modules enable row level security;
alter table public.modules force row level security;

-- A module is visible/writable only when its course belongs to the caller.
create policy modules_select_own on public.modules
  for select
  using (
    exists (
      select 1 from public.courses c
      where c.id = modules.course_id and c.user_id = (select auth.uid())
    )
  );

create policy modules_insert_own on public.modules
  for insert
  with check (
    exists (
      select 1 from public.courses c
      where c.id = modules.course_id and c.user_id = (select auth.uid())
    )
  );

create policy modules_update_own on public.modules
  for update
  using (
    exists (
      select 1 from public.courses c
      where c.id = modules.course_id and c.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = modules.course_id and c.user_id = (select auth.uid())
    )
  );

create policy modules_delete_own on public.modules
  for delete
  using (
    exists (
      select 1 from public.courses c
      where c.id = modules.course_id and c.user_id = (select auth.uid())
    )
  );

revoke all on table public.modules from anon, authenticated;
grant select, delete on table public.modules to authenticated;
grant insert (course_id, title, sequence) on table public.modules to authenticated;
-- course_id is deliberately NOT updatable: modules cannot move between courses.
grant update (title, sequence) on table public.modules to authenticated;

create trigger modules_set_updated_at
  before update on public.modules
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- exams (ownership inherited through the course)
-- ---------------------------------------------------------------------------

create table public.exams (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 120),
  exam_at timestamptz not null,
  weight numeric null check (weight is null or (weight >= 0 and weight <= 100)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index exams_course_id_exam_at_idx on public.exams (course_id, exam_at);

alter table public.exams enable row level security;
alter table public.exams force row level security;

create policy exams_select_own on public.exams
  for select
  using (
    exists (
      select 1 from public.courses c
      where c.id = exams.course_id and c.user_id = (select auth.uid())
    )
  );

create policy exams_insert_own on public.exams
  for insert
  with check (
    exists (
      select 1 from public.courses c
      where c.id = exams.course_id and c.user_id = (select auth.uid())
    )
  );

create policy exams_update_own on public.exams
  for update
  using (
    exists (
      select 1 from public.courses c
      where c.id = exams.course_id and c.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = exams.course_id and c.user_id = (select auth.uid())
    )
  );

create policy exams_delete_own on public.exams
  for delete
  using (
    exists (
      select 1 from public.courses c
      where c.id = exams.course_id and c.user_id = (select auth.uid())
    )
  );

revoke all on table public.exams from anon, authenticated;
grant select, delete on table public.exams to authenticated;
grant insert (course_id, title, exam_at, weight) on table public.exams to authenticated;
-- course_id is deliberately NOT updatable: exams cannot move between courses.
grant update (title, exam_at, weight) on table public.exams to authenticated;

create trigger exams_set_updated_at
  before update on public.exams
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- exam_modules: which modules an exam covers (normalized join table)
-- ---------------------------------------------------------------------------

create table public.exam_modules (
  exam_id uuid not null references public.exams (id) on delete cascade,
  module_id uuid not null references public.modules (id) on delete cascade,
  primary key (exam_id, module_id)
);

create index exam_modules_module_id_idx on public.exam_modules (module_id);

alter table public.exam_modules enable row level security;
alter table public.exam_modules force row level security;

-- A join row is valid only when the exam and the module belong to the SAME
-- course AND that course belongs to the caller. This makes it impossible to
-- attach someone else's module to your exam (or vice versa) by guessing IDs.
create policy exam_modules_select_own on public.exam_modules
  for select
  using (
    exists (
      select 1
      from public.exams e
      join public.courses c on c.id = e.course_id
      where e.id = exam_modules.exam_id and c.user_id = (select auth.uid())
    )
  );

create policy exam_modules_insert_own on public.exam_modules
  for insert
  with check (
    exists (
      select 1
      from public.exams e
      join public.modules m on m.course_id = e.course_id
      join public.courses c on c.id = e.course_id
      where e.id = exam_modules.exam_id
        and m.id = exam_modules.module_id
        and c.user_id = (select auth.uid())
    )
  );

create policy exam_modules_delete_own on public.exam_modules
  for delete
  using (
    exists (
      select 1
      from public.exams e
      join public.courses c on c.id = e.course_id
      where e.id = exam_modules.exam_id and c.user_id = (select auth.uid())
    )
  );

revoke all on table public.exam_modules from anon, authenticated;
-- Associations are replaced, not edited: no update grant.
grant select, insert, delete on table public.exam_modules to authenticated;
