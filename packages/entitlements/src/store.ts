/**
 * Mobile store-billing abstraction — M14 (spec H/I/Q).
 *
 * App-store subscriptions (Apple/Google) must flow through the SAME
 * normalized entitlement layer as web billing. This interface is the
 * integration boundary: a RevenueCat-style adapter implements it on native
 * once store products and API keys exist. Until then the app ships the
 * documented `notConfiguredPurchases` stub — we do NOT fabricate product IDs
 * or claim store billing is production-complete (spec I).
 */

export type PurchaseOutcome =
  | { status: 'success' }
  | { status: 'cancelled' }
  | { status: 'not_configured'; reason: string }
  | { status: 'error'; message: string };

export type RestoreOutcome =
  | { status: 'restored' }
  | { status: 'nothing_to_restore' }
  | { status: 'not_configured'; reason: string }
  | { status: 'error'; message: string };

/**
 * The contract every store adapter must satisfy. After ANY successful
 * purchase/restore, the adapter's backend (e.g. RevenueCat webhooks) writes
 * the normalized subscription row server-side; the client then refreshes
 * entitlements from the server. The adapter NEVER grants access locally.
 */
export interface StorePurchasesAdapter {
  /** Whether the adapter is configured for this platform/build. */
  isConfigured(): boolean;
  /** Begin the platform purchase flow for the PRO subscription. */
  purchasePro(): Promise<PurchaseOutcome>;
  /** Platform-required Restore Purchases (spec Q). */
  restorePurchases(): Promise<RestoreOutcome>;
}

export const STORE_NOT_CONFIGURED_REASON =
  'App-store billing is not configured yet: store products and RevenueCat keys require the ' +
  'Apple/Google developer accounts (documented in docs/worklogs/M14.md).';

/** The shipped default until store accounts/products exist. */
export const notConfiguredPurchases: StorePurchasesAdapter = {
  isConfigured: () => false,
  purchasePro: async () => ({ status: 'not_configured', reason: STORE_NOT_CONFIGURED_REASON }),
  restorePurchases: async () => ({ status: 'not_configured', reason: STORE_NOT_CONFIGURED_REASON }),
};
