# ADR-0039: Per-environment projects, forward-only migrations, honest ops docs

- **Status:** Accepted
- **Date:** 2026-08-14
- **Milestone:** M14

## Context

M14 requires clear development/staging/production separation (spec AA), a
documented Supabase environment strategy without blindly creating
production infrastructure (spec AB), an explicit migration process
(spec AC), backup/restore documentation (spec AJ), and account-deletion
semantics with their billing implications (spec AL). Reality: one Supabase
project exists for development today; production does not, and should not
be created as a side effect of tooling.

## Decision

### 1. One Supabase project per environment, one Stripe mode per environment

development and staging use separate projects with Stripe **test** keys and
their own webhook signing secrets; production is created **deliberately by
the founder** near launch with Stripe **live** keys. Secrets live in each
project's function secrets — the same variable NAMES everywhere
(documented in `.env.example`), different values, never `EXPO_PUBLIC_*`
(spec U/V). `EXPO_PUBLIC_APP_ENV` already distinguishes
development/preview/production client builds via `@avidia/config`.

### 2. Migrations: filename order, forward-only, staging first

Schema changes are numbered SQL files in `supabase/migrations/`, applied in
order per environment (SQL editor or `supabase db push`). No down
migrations — mistakes are corrected by a NEW forward migration, so every
environment's history stays linear and auditable. Staging always receives a
migration before production. Seed data (`seed/`, the simulation case
library) is product content and ships everywhere; throwaway test data never
enters `migrations/`.

### 3. Backups and retention: document reality, invent nothing

Supabase paid tiers provide daily backups; the free tier does not. The
production project must be on a backed-up plan BEFORE launch and a restore
rehearsed once on staging. Retention: learning data lives until the user
deletes it or their account; billing rows hold provider identifiers and
status only (never card data); `billing_events` retains event ids for
idempotency/audit. Longer retention promises require a legal decision and
are not invented in engineering docs (spec AM). Privacy Policy / Terms
surfaces in the app are explicit placeholders marked "pending legal
review" (spec AN).

### 4. Account deletion and its billing implication

`delete_my_account()` removes storage objects and the `auth.users` row
(cascading through every owned table). Deleting an account does NOT cancel
a provider subscription — so the function REFUSES while an
`active/trialing/past_due` subscription is not set to cancel at period end,
directing the student to cancel first (portal for Stripe; store settings
for future store billing). This is the honest ordering: we never silently
keep charging a deleted user (verified by authz section 71).

## Consequences

- No accidental production infrastructure; creating it is a deliberate,
  documented founder step.
- Linear migration history means any environment can be reproduced from
  zero by replaying `migrations/` in order.
- The deletion guard trades a small amount of friction for the guarantee
  that deletion never strands an active charge.
