/**
 * Webhook event normalization — M14 (spec F/G).
 *
 * The Stripe webhook edge function is deliberately thin: it verifies the
 * signature, records the provider event ID for idempotency, and applies the
 * subscription snapshot. The MAPPING from provider events to our normalized
 * subscription row lives here, pure and unit-tested, so lifecycle logic is
 * never scattered through infrastructure code.
 */

import { normalizeStripeStatus, type SubscriptionStatus } from './status';

/** Stripe events the webhook cares about (spec F); others are acknowledged and ignored. */
export const HANDLED_STRIPE_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
] as const;

export function isHandledStripeEvent(eventType: string): boolean {
  return (HANDLED_STRIPE_EVENTS as readonly string[]).includes(eventType);
}

/** The normalized snapshot the webhook upserts (keyed by provider subscription ID). */
export interface SubscriptionSnapshot {
  provider: 'stripe';
  providerCustomerId: string;
  providerSubscriptionId: string;
  productId: string | null;
  plan: 'pro';
  status: SubscriptionStatus;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
}

interface StripeSubscriptionObject {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end?: boolean;
  current_period_start?: number | null;
  current_period_end?: number | null;
  trial_end?: number | null;
  items?: { data?: Array<{ price?: { product?: string | null } | null }> };
}

function epochToIso(epochSeconds: number | null | undefined): string | null {
  if (typeof epochSeconds !== 'number') return null;
  return new Date(epochSeconds * 1000).toISOString();
}

/**
 * Normalize a Stripe subscription object into our snapshot. Deleted
 * subscriptions arrive with their final state; `deleted=true` forces the
 * terminal status (Stripe sends `customer.subscription.deleted` with status
 * 'canceled').
 */
export function snapshotFromStripeSubscription(
  subscription: StripeSubscriptionObject,
  options?: { deleted?: boolean }
): SubscriptionSnapshot {
  // Period math (has access NOW?) is applied at read time by
  // grantsPaidAccess / SQL current_plan — the snapshot only records state.
  const status: SubscriptionStatus = options?.deleted
    ? 'canceled'
    : normalizeStripeStatus(subscription.status);
  return {
    provider: 'stripe',
    providerCustomerId: subscription.customer,
    providerSubscriptionId: subscription.id,
    productId: subscription.items?.data?.[0]?.price?.product ?? null,
    plan: 'pro',
    status,
    currentPeriodStart: epochToIso(subscription.current_period_start),
    currentPeriodEnd: epochToIso(subscription.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
    trialEnd: epochToIso(subscription.trial_end),
  };
}

/**
 * Idempotent apply (spec G): given already-processed provider event IDs,
 * decide whether an event should be processed. Duplicate deliveries are
 * acknowledged without reprocessing — no double entitlement extension, no
 * duplicate telemetry. (In SQL this is `billing_events`' unique index; the
 * pure version documents and tests the contract.)
 */
export function shouldProcessEvent(
  processedEventIds: ReadonlySet<string>,
  eventId: string
): boolean {
  return !processedEventIds.has(eventId);
}
