# Supabase backend

Playbook §4 location for database migrations, seed data, and edge functions.
M1 adds `migrations/` (user profile foundation + row-level security). `seed/`
and `functions/` arrive with the milestones that give them real content.

## One-time project setup (founder)

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine for development).
2. In the SQL Editor, run each file in `migrations/` in filename order
   (`0001_user_profiles.sql`, `0002_courses_modules_exams.sql`,
   `0003_documents_and_storage.sql`). Alternatively, with the Supabase CLI:
   `supabase link --project-ref <ref>` then `supabase db push`.
   Migration `0003` also creates the private `course-materials` storage bucket
   (50 MB per-file limit, supported MIME types only) and its storage policies —
   no manual bucket setup in the dashboard is needed.
3. Copy the project URL and anon key from **Project Settings → API** into your
   local `.env` as `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`
   (see `.env.example`).
4. Optional for development speed: in **Authentication → Providers → Email**,
   you may disable "Confirm email" so new sign-ups can sign in immediately.
   Keep it enabled for production.

## Verifying authorization (RLS)

With `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` set
in the shell environment (service-role key is a secret — never in `.env` files
that could be committed, never in client code):

```bash
pnpm run test:authz
```

This creates two throwaway users and verifies every ownership rule from M1
(profiles), M2 (courses/modules/exams/exam_modules, including cross-user and
cross-course link denial and cascade behavior), and M3 (documents and the
`course-materials` bucket: cross-user upload/download/list/replace/delete all
denied, forged storage keys rejected by the database, anonymous access denied),
then deletes the users and any test objects.
