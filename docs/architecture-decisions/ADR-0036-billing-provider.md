# ADR-0036: Stripe for web billing, webhooks as the only writer

- **Status:** Accepted
- **Date:** 2026-08-14
- **Milestone:** M14

## Context

M14 requires production-grade subscription billing (spec E–G). The Playbook
mandates "Stripe web + native IAP where required, normalized entitlements".
The core principle constrains every option: **payments must never be
client-authoritative**. We also have no HTTP server — `apps/worker` is a
polling job processor — so webhook and checkout endpoints need a home.

## Decision

### 1. Stripe, via hosted surfaces only

Web billing uses Stripe Checkout for purchase and the Stripe Billing Portal
for payment-method changes, cancellation and invoices (spec R). We build no
custom card UI and never touch card data (spec T): the client receives only
Stripe-hosted URLs from authenticated edge functions. PCI scope stays with
Stripe.

### 2. Supabase Edge Functions host the billing endpoints

`stripe-webhook`, `create-checkout-session`, `create-billing-portal-session`
and `health` are Deno edge functions in `supabase/functions/`. They live
next to the database they write, deploy per environment with per-environment
secrets (`supabase secrets set`), and add no new server to operate. The
functions are deliberately thin; every mapping decision (event routing,
status normalization, snapshot shape, idempotency contract) is mirrored from
the pure, unit-tested `@avidia/entitlements` package.

### 3. The webhook is the ONLY writer of subscription state

`subscriptions` has no INSERT/UPDATE/DELETE policies for authenticated users
— a client cannot create, extend or delete a subscription row, its own or
anyone's (verified by authz sections 64–66). The webhook verifies Stripe's
HMAC-SHA256 signature over `${timestamp}.${body}` with constant-time
comparison and a 5-minute replay tolerance, and is deployed with
`--no-verify-jwt` because the signature is the authentication.

### 4. Idempotency by provider event id

Every processed event id is recorded in `billing_events` under a
`(provider, provider_event_id)` unique index. Duplicate deliveries are
acknowledged with 200 and processed zero times (spec G, billing case AY-D).
Unattributable subscription events return 500 so Stripe retries after the
linking `checkout.session.completed` arrives.

## Consequences

- No card data, no PCI burden, no custom payment UI to maintain.
- Billing works even when the app is closed: Stripe → webhook → database.
- A Stripe outage cannot corrupt entitlements; it only delays snapshots
  (bounded client cache trust covers reads — ADR-0037).
- The Stripe REST API is called directly (form-encoded fetch) instead of the
  SDK, keeping the Deno functions dependency-free; the small surface we use
  (checkout sessions, portal sessions, subscription retrieve) is stable.
