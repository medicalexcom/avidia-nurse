# Stage 1 live verification — CI authz activation, DB fixes, edge function + auth config

Date: 2026-08-25. Post-M15 (M15 is the final feature milestone; this is
`RELEASE_CHECKLIST.md` Stage 1 — founder infrastructure — work against the
live Supabase project, not a new product milestone).

## What this covered

Stage 1 requires CI's authz (RLS/IDOR) job to activate and pass, and the
`health` edge function to be deployed and reachable. Both were open before
today; both are closed now.

### CI authz harness activated and passing

Repo secrets `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
were added, so `pnpm run test:authz` (`scripts/authz-check.mjs`, ~135
checks across 71 sections) now runs for real against the live project in
CI instead of SKIPPING. Its first live run surfaced three failures, all
now fixed and verified live:

- **Missing column grants (migration `0021`).** `0018`'s INSERT/UPDATE
  column grants on `ai_learning_requests` / `tutor_conversations` /
  `tutor_messages` were never applied to the live database (this
  project's migration history isn't CLI-tracked; `0018` was applied by
  hand and these grant statements were dropped somewhere in that
  process). `0021` reapplies exactly the grants `0018` already specifies.
  Confirmed live via `information_schema.role_column_grants` — 15 rows,
  matching the migration exactly. (Note: `role_table_grants` does not
  surface column-level grants — only `role_column_grants` /
  `column_privileges` do; an early diagnostic pass queried the wrong view
  and reported a false negative before this was caught.)
- **Direct `storage.objects` delete (migration `0022`).** Supabase no
  longer permits deleting `storage.objects` rows directly via SQL, which
  broke `delete_my_account()`. `0022` removes that statement; storage
  cleanup moves client-side (`billingApi.ts`'s `deleteMyAccount` — lists
  the caller's storage keys, calls the RPC, and only removes those
  objects once it succeeds, never on the guarded/blocked path). Confirmed
  live via `pg_proc.prosrc` — the function no longer references
  `storage.objects`. Tests updated (`billing.test.ts`); 19/19 billing
  tests, 279/279 full app suite pass.
- **Test-script bug, not a database bug (`scripts/authz-check.mjs`).**
  After both fixes above were verified live at the Postgres level, CI
  still failed the same three tutor/personalized-learning INSERT checks,
  identically, across three re-runs. Root cause: those checks reused
  `courseId` (created early in the suite), but an earlier section (`18`,
  cascade-delete coverage) had already deleted that exact course — so the
  owner/course `with_check` clause those inserts depend on could never
  pass, regardless of grants or policy correctness. Fixed by giving that
  section its own course instead of reusing a deleted one.

CI is now fully green: `Lint, typecheck, test, build web`, `Dependency
audit`, `Secret scan` all pass, and the authz job's own log ends
`All authorization checks passed.`

### `health` edge function deployed

Only `content-review` was live before today. `health` (M14 spec AI) has
no dependencies (no Stripe, no worker) and was deployed via the Supabase
dashboard editor, inlining its two `_shared/` imports (`http.ts`,
`billing.ts`) as sibling files since the dashboard's per-function editor
doesn't resolve `../_shared/...` outside the function's own root the way
the CLI/monorepo layout does.

Its "Verify JWT with legacy secret" gateway setting was ON by default on
deploy — that contradicts the function's own design ("no auth required,
must work when auth is broken"), so it was turned off. Verified with a
direct unauthenticated call:

```
GET https://ydfbmzgeavkwvnslawny.supabase.co/functions/v1/health
200 {"status":"ok","database":"ok","latency_ms":100,"checked_at":"2026-08-25T21:29:55.881Z"}
```

Billing edge functions (`create-checkout-session`,
`create-billing-portal-session`, `stripe-webhook`) remain undeployed —
they need live Stripe keys first, which is Stage 3 scope, not Stage 1.

### Password-reset redirect URLs allow-listed

`resetPasswordForEmail`'s `redirectTo` was being rejected because the
project's Authentication → URL Configuration → Redirect URLs allow-list
was empty, even though the app code (`requestPasswordReset` /
`updatePassword` in `AuthProvider.tsx`) has been complete since M14. Added
all three documented URLs:

- `https://medicalexcom.github.io/avidia-nurse/reset-password` (production)
- `http://localhost:8081/reset-password` (local dev)
- `avidianurse:///reset-password` (native, ready ahead of distribution)

### Deployment history note

`deploy-web.yml` (GitHub Pages) uses `concurrency: {group: pages,
cancel-in-progress: true}`, so pushing several commits in quick
succession — as happened during this session — cancels whatever deploy
was still mid-flight for the previous commit. The repo's Deployments tab
shows those cancelled runs as red/failed, which looked alarming but
isn't: the cancelled runs' own logs say `Cancelled`, not `Failed`, and
each superseding commit's deploy completed successfully. The current
`main` HEAD is live and serving correctly.

## Verified end state (2026-08-25)

- CI green on `main` (commit `12e36e2`): lint, typecheck, test, build,
  authz (all checks pass), dependency audit, secret scan.
- `main` is deployed to GitHub Pages and loads correctly.
- Migrations applied through `0022`, both live-verified at the Postgres
  catalog level (not just "file exists in repo").
- Edge functions live: `content-review`, `health`. Billing functions:
  not yet (Stage 3).
- Password-reset redirect allow-list: populated (production, local dev,
  native).

## What's still open for Stage 1 / later stages

- Local dev env vars, worker config, and the founder's own
  sign-up/create-course smoke test are the founder's own local actions,
  not verifiable from here.
- Stripe test-mode setup and billing edge function deployment (Stage 3).
- Seed content authoring (Stage 3).
- Everything else in `docs/RELEASE_CHECKLIST.md` Stage 2 onward is
  unchanged by this session.
