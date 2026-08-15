# Operations Runbook

Day-to-day operation of Avidia Nurse for a solo founder running a closed
beta. Written against the actual system (M0–M15); commands assume the
repo root and the Supabase CLI linked to the relevant project.

## Routine health

- App/database: `GET <SUPABASE_URL>/functions/v1/health` → `{status:'ok', database:'up', latency_ms}`; 503 means the database probe failed.
- CI: every push to main runs format/lint/typecheck/tests/build, authz (when secrets set), dependency audit, secret scan. A red main is the first alarm.
- Worker: it logs one structured line per document stage. If uploads sit in `processing`, check the worker process first; stale `processing` rows are auto-recovered to retryable `failed` on the next worker pass.

## Document pipeline incidents

Symptom: student uploads stuck or failed.

1. Check worker logs for the document id (no content is logged).
2. Failures are stored with a student-safe message and are retryable from the app (Retry on the document row).
3. AI provider outage/rate limit: extraction and question generation fail into `failed` with retry; already-processed content, practice, mastery, analytics, planner, and canonical simulations keep working without AI. Resume the worker when the provider recovers and retry the documents.

## AI cost control

Usage counters (`usage_counters`) record document/generation/simulation usage per user per month ALWAYS, flag or no flag. Query them to spot runaway users. Rate limits (30 uploads/hr, 20 sim starts/hr) bound burst cost. If a provider is burning money: stop the worker (uploads queue safely as `pending`).

## Billing incidents

- Stripe events are replayable from the Stripe dashboard; the webhook is idempotent, so re-sending is always safe.
- A subscription row that looks wrong: check `billing_events` for the event trail, then re-send the latest subscription event from Stripe.
- Webhook signature failures (400s in function logs): confirm `STRIPE_WEBHOOK_SECRET` matches the endpoint's current secret.
- Never edit `subscriptions` rows by hand except with the service role in an emergency, and record what and why.

## Launching / halting billing enforcement

```sql
update public.feature_flags set enabled = true  where flag = 'subscriptions'; -- enforce
update public.feature_flags set enabled = false where flag = 'subscriptions'; -- stand down
```

Both are instant, deploy-free, and safe: counters keep recording either way.

## Deploying changes

1. Merge to main with CI green.
2. Database: `supabase db push` (or apply the new migration file) dev → staging → production. Forward-only; mistakes get a new migration.
3. Edge functions: `supabase functions deploy <name>` (`stripe-webhook` with `--no-verify-jwt`).
4. Web: CI deploys the Pages preview; production host at launch.
5. Native: `eas build --profile preview|production` (see `apps/app/eas.json`).

## Backups and restore

Free tier has NO backups. Before real users: production on a backed-up plan, then rehearse once on staging: take a backup, restore to a scratch project, verify a student's courses/mastery are intact, write down the time it took. Do not claim restore works until this rehearsal has happened.

## Student support paths (closed beta)

- Bug reports and product feedback: direct email to the founder (beta cohort is 5–20 people; no ticketing system by design).
- Questionable question content: students tap "Report a problem" on any question; reports land in `question_feedback` (stored, never auto-applied). Review them:
  ```sql
  select qf.created_at, qf.question_id, qf.reason, qf.note
  from question_feedback qf order by qf.created_at desc limit 50;
  ```
- Account deletion/export: self-serve in the profile.

## Secret rotation

If any credential leaks: rotate at the provider first (Supabase service key, Stripe key/webhook secret, AI keys), update `supabase secrets set` / worker host / CI secrets, then verify health + one webhook round-trip. History rewriting is not a substitute.
