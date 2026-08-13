# Supabase backend

Playbook §4 location for database migrations, seed data, and edge functions.
M1 adds `migrations/` (user profile foundation + row-level security). `seed/`
and `functions/` arrive with the milestones that give them real content.

## One-time project setup (founder)

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine for development).
2. In the SQL Editor, run each file in `migrations/` in filename order
   (currently just `0001_user_profiles.sql`). Alternatively, with the Supabase
   CLI: `supabase link --project-ref <ref>` then `supabase db push`.
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

This creates two throwaway users, verifies every M1 ownership rule (own-row
read/update only, no privileged-field changes, no cross-user access, no
insert/delete, nothing for anonymous clients), and deletes the users.
