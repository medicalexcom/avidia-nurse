# Environments

Definitive checklist for the three Avidia Nurse environments (M15 spec AN,
ADR-0039). One Supabase project per environment; same variable NAMES
everywhere, different values; nothing secret is ever `EXPO_PUBLIC_*`.

Current reality (2026-08-14): **no Supabase project exists in any
environment yet.** The founder creates development first, then staging,
then production deliberately near launch. Nothing below is provisioned
until that happens.

## Matrix

| Concern                                                                       | DEVELOPMENT                                                                                                                   | STAGING                                          | PRODUCTION                                                                       |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| Supabase project                                                              | dev project (founder creates first)                                                                                           | separate staging project                         | separate project, created deliberately near launch, on a **backed-up paid plan** |
| Migrations                                                                    | applied first here                                                                                                            | staging next (rehearsal)                         | last, only after staging passes                                                  |
| App env                                                                       | `EXPO_PUBLIC_APP_ENV=development`                                                                                             | `preview`                                        | `production`                                                                     |
| `EXPO_PUBLIC_SUPABASE_URL` / `ANON_KEY`                                       | dev project values                                                                                                            | staging values                                   | production values                                                                |
| Web deploy                                                                    | local `expo start`                                                                                                            | GitHub Pages preview (current CI deploy)         | production host (decide at launch; SPA rewrite needed)                           |
| Native builds                                                                 | Expo Go / dev client                                                                                                          | EAS `preview` profile (internal distribution)    | EAS `production` profile (auto-increment build numbers)                          |
| AI providers                                                                  | test API keys, low quotas                                                                                                     | test keys                                        | production keys with billing alerts                                              |
| Worker secrets                                                                | `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` for dev project                                                                 | staging values                                   | production values, stored only in the worker host's secret manager               |
| Stripe                                                                        | test mode                                                                                                                     | test mode (separate webhook endpoint + `whsec_`) | **live mode** keys, live webhook endpoint                                        |
| Edge function secrets                                                         | `supabase secrets set` per project: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_PRO`, `BILLING_RETURN_URL` | same names, staging values                       | same names, live values                                                          |
| `subscriptions` feature flag                                                  | as needed for testing                                                                                                         | `true` for billing rehearsal                     | `false` until launch decision, then `true`                                       |
| Analytics                                                                     | console only (`__DEV__`)                                                                                                      | `EXPO_PUBLIC_ANALYTICS_KEY` optional             | production key                                                                   |
| Error monitoring                                                              | none                                                                                                                          | `SENTRY_DSN` (when wired)                        | `SENTRY_DSN` (when wired)                                                        |
| Backups                                                                       | none needed                                                                                                                   | optional                                         | **required before launch** + one rehearsed restore                               |
| CI secrets (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) | point at a disposable dev/staging project to activate `test:authz`                                                            | —                                                | never point CI at production                                                     |

## Rules

- A development key must never be used in production; a production
  service-role key must never leave the worker host / Supabase secrets.
- Migrations are forward-only and filename-ordered; a mistake gets a NEW
  migration, applied dev → staging → production.
- No production migration without the migration file in git.
- Production is never created as a side effect of tooling.
