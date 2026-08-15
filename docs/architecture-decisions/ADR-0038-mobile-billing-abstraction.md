# ADR-0038: Store billing behind an adapter; honest not-configured stub

- **Status:** Accepted
- **Date:** 2026-08-14
- **Milestone:** M14

## Context

Mobile platforms require in-app purchases for digital subscriptions
(spec H), and the platforms require a Restore Purchases affordance
(spec Q). But the Apple/Google developer accounts, store products and
RevenueCat (or equivalent) API keys do not exist yet, and spec I forbids
pretending otherwise: do not fabricate product IDs, do not claim store
billing is production-complete.

## Decision

### 1. One integration boundary: `StorePurchasesAdapter`

`@avidia/entitlements` defines the contract every store implementation must
satisfy: `isConfigured()`, `purchasePro()`, `restorePurchases()`, with
closed outcome unions (`success | cancelled | not_configured | error`;
restore adds `nothing_to_restore`). The contract's key rule: **the adapter
never grants access locally.** After any successful purchase/restore, the
adapter's backend (e.g. RevenueCat webhooks) writes the same normalized
`subscriptions` rows the Stripe webhook writes, and the client refreshes
entitlements from the server. Apple/Google/Stripe subscriptions are
indistinguishable to the entitlement layer (spec J;
`normalizeStoreState` maps store entitlement states to the five normalized
statuses).

### 2. Ship the truth: `notConfiguredPurchases`

The app wires the documented stub. On native, "Continue to checkout" and
"Restore purchases" report that purchases are not available in this build
yet (tested — billing case AY-H). No fake product IDs, no dead store flow,
no pretending.

### 3. What activation requires (manual, founder — documented)

Apple Developer + Google Play accounts; PRO subscription products in App
Store Connect / Play Console; a RevenueCat project with those products and
API keys; a RevenueCat-backed `StorePurchasesAdapter` implementation
replacing the stub export in `src/features/billing/purchases.ts`; and
RevenueCat webhook → server writes into `subscriptions`. The interface,
tests, entitlement layer and UI paths are already in place.

## Consequences

- Store billing can be added without touching the entitlement model, the
  paywall, or the database schema.
- Until then, native users see an honest message and can subscribe on web;
  their PRO resolves on every platform because entitlements are
  provider-agnostic and server-side.
- Restore Purchases exists in the UI now, so the platform-required surface
  is not an afterthought bolted on at submission time.
