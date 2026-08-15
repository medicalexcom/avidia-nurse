# Supabase backend

Playbook §4 location for database migrations, seed data, and edge functions.
M1 adds `migrations/` (user profile foundation + row-level security). `seed/`
and `functions/` arrive with the milestones that give them real content.

## One-time project setup (founder)

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine for development).
2. In the SQL Editor, run each file in `migrations/` in filename order
   (`0001_user_profiles.sql`, `0002_courses_modules_exams.sql`,
   `0003_documents_and_storage.sql`, `0004_document_sections_and_processing.sql`,
   `0005_source_chunks_and_retrieval.sql`, `0006_concepts_and_knowledge.sql`,
   `0007_questions_and_assessment.sql`, `0008_mastery_and_scheduling.sql`,
   `0009_daily_study_sessions.sql`, `0010_study_modes.sql`).
   Alternatively, with the Supabase CLI:
   `supabase link --project-ref <ref>` then `supabase db push`.
   Migration `0003` also creates the private `course-materials` storage bucket
   (50 MB per-file limit, supported MIME types only) and its storage policies —
   no manual bucket setup in the dashboard is needed. Migration `0004` adds the
   `document_sections` table, the processing state-machine trigger, and the
   service-role-only `replace_document_sections` function used by the worker.
   Migration `0005` enables the `pgvector` extension and adds the
   `source_chunks` table (semantic chunks + embeddings), the indexing
   lifecycle columns on `documents`, and the `replace_source_chunks` /
   `search_course_chunks` functions. Migration `0006` adds the course-scoped
   knowledge model — `concepts`, `concept_aliases`, `concept_sources`,
   `concept_relationships` — the `knowledge_status` lifecycle columns on
   `documents`, the service-role-only `apply_concept_extraction` /
   `recompute_concept_emphasis` functions, and the document-delete trigger
   that prunes AI concepts left without supporting evidence.
3. Copy the project URL and anon key from **Project Settings → API** into your
   local `.env` as `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`
   (see `.env.example`).
4. Optional for development speed: in **Authentication → Providers → Email**,
   you may disable "Confirm email" so new sign-ups can sign in immediately.
   Keep it enabled for production.

## Running the worker (M4 extraction + M5 indexing + M6 knowledge)

The background worker extracts uploaded materials into `document_sections`,
indexes ready documents into `source_chunks` (semantic chunks + embeddings)
so retrieval works, and then extracts nursing concepts from indexed
documents into the course knowledge model. It needs the project URL, the
**service-role key** (Project Settings → API), an embedding provider and a
concept-extraction provider — all server-side environment variables — these
are secrets: never in `.env` files that could be committed, never in any
`EXPO_PUBLIC_*` variable, never in client code.

```bash
export SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service role key>
export OPENAI_API_KEY=<openai api key>     # embeddings + concept extraction
# Optional overrides:
# export CONCEPT_PROVIDER=openai           # or "scripted" (keyless dev ONLY)
# export CONCEPT_MODEL=gpt-4o-mini
# or, for keyless local development only (NOT production):
# export EMBEDDING_PROVIDER=hashing

pnpm --filter @avidia/worker start        # poll loop (every 5 seconds)
pnpm --filter @avidia/worker start:once   # drain both queues once, then exit
```

The worker only performs legal state-machine transitions (a database trigger
reserves `processing`/`ready` for the service role) and logs document ids,
statuses, and chunk counts only — never file content or credentials.

### Internal retrieval inspector (developer-only)

With the same environment set, inspect what retrieval returns for a course:

```bash
pnpm --filter @avidia/worker search -- --course <course-uuid> \
  --query "priority intervention for DKA" [--document <uuid>] \
  [--top-k 8] [--min-similarity 0.2]
```

Prints chunk text, fused/cosine/lexical scores, and provenance
("file.pptx — slide 17 — Pulmonary Embolism"). This is a server-side dev
tool; it is never exposed to students.

## Verifying authorization (RLS)

With `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` set
in the shell environment (service-role key is a secret — never in `.env` files
that could be committed, never in client code):

```bash
pnpm run test:authz
```

This creates two throwaway users and verifies every ownership rule from M1
(profiles), M2 (courses/modules/exams/exam_modules, including cross-user and
cross-course link denial and cascade behavior), M3 (documents and the
`course-materials` bucket: cross-user upload/download/list/replace/delete all
denied, forged storage keys rejected by the database, anonymous access denied),
M4 (processing + sections: owners can enqueue but cannot enter
`processing`/`ready`; only the service role can write `document_sections`;
cross-user and anonymous section reads return nothing; course deletion
cascades to sections), and M5 (retrieval: only the service role can write
`source_chunks`; the raw embedding vector is not selectable by any client;
cross-user and anonymous chunk reads return nothing even with exact ids;
`search_course_chunks` raises for a course the caller does not own and is
denied to anonymous callers; course deletion cascades to chunks), and M6
(knowledge model: `apply_concept_extraction` and `recompute_concept_emphasis`
are service-role-only; owners read their concepts, aliases, evidence links
and relationships while user B and anonymous clients read nothing even with
exact guessed ids; direct client writes to all four concept tables are
denied; deleting a document removes its evidence and prunes orphaned AI
concepts; course deletion cascades to the entire knowledge model), then
deletes the users and any test objects.

## M14: billing, entitlements and edge functions

Migration `0015_subscriptions_and_entitlements.sql` adds the billing layer:
`feature_flags` (with the `subscriptions` enforcement switch, shipped
**disabled**), `subscriptions` (normalized, read-own-only; ONLY the service
role writes it), `billing_events` (webhook idempotency ledger, no client
access), `usage_counters` + `rate_limit_hits` (server-side cost controls),
the entitlement functions (`current_plan`, `get_my_entitlements`), the
account functions (`export_my_data`, `delete_my_account`), and the
flag-gated FREE-plan limit triggers. Until the `subscriptions` flag is
flipped to `true`, behavior is identical to M13 — usage is recorded, but
nothing is enforced or paywalled.

### Edge functions (`functions/`)

| Function                        | Auth                                             | Purpose                                                                                                                            |
| ------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `stripe-webhook`                | Stripe signature (deploy with `--no-verify-jwt`) | The ONLY writer of subscription state. Verifies `Stripe-Signature`, dedupes by provider event id, upserts the normalized snapshot. |
| `create-checkout-session`       | Supabase JWT                                     | Returns a Stripe-hosted checkout URL for PRO (`client_reference_id` = user id).                                                    |
| `create-billing-portal-session` | Supabase JWT                                     | Returns a Stripe-hosted portal URL (cancel / payment method / invoices).                                                           |
| `health`                        | none                                             | Liveness + database reachability, no internals exposed.                                                                            |

Deploy and configure (per environment):

```bash
supabase functions deploy health create-checkout-session create-billing-portal-session
supabase functions deploy stripe-webhook --no-verify-jwt
supabase secrets set STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... \
  STRIPE_PRICE_ID_PRO=price_... BILLING_RETURN_URL=https://<app>/profile
```

Then point a Stripe webhook endpoint (test mode first) at
`https://<ref>.functions.supabase.co/stripe-webhook` subscribed to:
`checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.payment_failed`.

### Environment strategy (spec AA/AB/AC — ADR-0039)

One Supabase project **per environment**, never shared:

- **development** — free-tier project per developer (or one shared dev
  project), Stripe **test** mode, `subscriptions` flag freely toggled.
- **staging/preview** — its own project, Stripe **test** mode, used for the
  manual billing validation pass before any production change.
- **production** — created deliberately by the founder when launch nears
  (NOT created automatically by tooling), Stripe **live** mode, backups
  verified (below) before real users arrive.

Migrations are applied **in filename order, forward-only** in every
environment (SQL editor or `supabase db push`); staging always receives a
migration before production does. Seed data separation: `seed/` content
(simulation case library, migration `0012`) is product data and ships
everywhere; throwaway dev/test data must never live in `migrations/`.

### Backups & retention (spec AJ/AM — documented, not invented)

Supabase Pro-tier projects take daily automated backups (restore via
Dashboard → Database → Backups); the free tier does NOT include
point-in-time recovery, which is acceptable for development only — the
production project must be on a plan with backups before launch, and a
restore must be rehearsed once on staging. Data retention policy: learning
data is kept until the user deletes it (or their account —
`delete_my_account()` removes everything owned, including storage objects);
billing rows keep only provider identifiers/status (never card data);
`billing_events` keeps event ids for idempotency and audit. Any
retention-window promises beyond this require a legal/founder decision and
are NOT invented here (spec AM).

M14 authz additions to `pnpm run test:authz` (sections 64–71): clients
cannot write subscriptions/billing_events/usage_counters or flip feature
flags (forged premium denied), subscription reads are strictly own-row,
duplicate webhook event ids are rejected, `get_my_entitlements` resolves
FREE/PRO server-side, `export_my_data` is caller-scoped, and
`delete_my_account` refuses while a subscription would keep charging, then
removes the auth user, owned rows and storage objects.
