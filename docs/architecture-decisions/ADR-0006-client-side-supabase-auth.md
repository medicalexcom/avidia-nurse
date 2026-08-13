# ADR-0006: Client-side Supabase auth with a public anon key under RLS

- **Status:** Accepted
- **Date:** 2026-08-12
- **Milestone:** M1

## Context

M1 requires authentication and a user profile. The Playbook's environment table lists
`SUPABASE_URL` / `SUPABASE_*` keys as server-side, but client-side Supabase authentication
(email/password from the app itself, with session persistence and token refresh on-device)
requires the project URL and the **anon** key to be present in the app bundle. ADR-0003 forbids
secrets in the client, so this needed an explicit decision rather than a silent exception.

## Decision

1. The Supabase **anon key is treated as public by design**. It is shipped to clients as
   `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY`, consistent with Supabase's own
   security model: the anon key grants nothing by itself; every data-access decision is enforced
   by Postgres row-level security and column-level grants on the server.
2. Consequently, **RLS is the security boundary**, not the client. Every table reachable from
   the client must have RLS enabled and forced, with explicit policies, before any client code
   touches it (done for `public.profiles` in migration 0001). Column-level grants restrict which
   fields a user may update; client-side sanitization is a UX nicety, never the authority.
3. The **service-role key remains strictly server-side** (CI secrets, backend environments). It
   is used only by the authorization test harness (`scripts/authz-check.mjs`) and future backend
   services, and must never use the `EXPO_PUBLIC_` prefix. gitleaks scanning in CI guards
   against accidental commits.
4. Both client variables are **optional** in the env schema: without them the app builds and
   runs with auth in a `backend-unavailable` state, keeping local development and CI independent
   of a live project.

## Consequences

- Anyone can extract the anon key from the bundle; this is expected and safe **only** as long as
  the RLS discipline in (2) is followed for every future table. This becomes a standing review
  requirement for all migrations.
- Authorization must be verified against a real project, not mocks — hence the `test:authz`
  harness, which skips cleanly until project secrets exist and then runs unconditionally in CI.
- ADR-0003 stands unmodified: the anon key is classified as non-secret configuration, so no
  exception to "no secrets in the client" is created.
