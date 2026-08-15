import { notConfiguredPurchases, type StorePurchasesAdapter } from '@avidia/entitlements';

/**
 * The app's store-billing adapter (spec H/I/Q).
 *
 * Store billing (Apple/Google) requires developer accounts, store products
 * and RevenueCat (or equivalent) API keys that DO NOT EXIST YET. Per spec I
 * we do not fabricate product IDs or pretend store billing is live: the app
 * ships the honest `notConfiguredPurchases` stub, and the paywall renders
 * "purchases aren't available in this build yet" on native.
 *
 * When the accounts exist, replace this export with a RevenueCat-backed
 * implementation of `StorePurchasesAdapter` (interface + outcome contract
 * already tested in @avidia/entitlements). Its backend webhook must write
 * the same normalized `subscriptions` rows the Stripe webhook writes —
 * the entitlement layer is provider-agnostic by design (spec J). The
 * required manual configuration is documented in docs/worklogs/M14.md.
 */
export const purchases: StorePurchasesAdapter = notConfiguredPurchases;
