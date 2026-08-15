import { grantsPaidAccess } from './status';
import {
  HANDLED_STRIPE_EVENTS,
  isHandledStripeEvent,
  shouldProcessEvent,
  snapshotFromStripeSubscription,
} from './webhook';
import { notConfiguredPurchases } from './store';

/**
 * Webhook normalization + idempotency tests — M14 (spec F/G, billing cases
 * AY-D and AY-H at the deterministic level; live signature verification is
 * exercised against the edge function in provider sandbox — documented).
 */

const stripeSub = {
  id: 'sub_123',
  customer: 'cus_456',
  status: 'active',
  cancel_at_period_end: false,
  current_period_start: 1755000000,
  current_period_end: 1757592000,
  trial_end: null,
  items: { data: [{ price: { product: 'prod_pro' } }] },
};

describe('event routing (spec F)', () => {
  it('handles the subscription lifecycle events and ignores everything else', () => {
    for (const eventType of HANDLED_STRIPE_EVENTS) {
      expect(isHandledStripeEvent(eventType)).toBe(true);
    }
    expect(isHandledStripeEvent('charge.succeeded')).toBe(false);
    expect(isHandledStripeEvent('customer.created')).toBe(false);
  });
});

describe('snapshot normalization (spec C/D/J)', () => {
  it('normalizes a live Stripe subscription into the trusted row shape', () => {
    const snapshot = snapshotFromStripeSubscription(stripeSub);
    expect(snapshot).toEqual({
      provider: 'stripe',
      providerCustomerId: 'cus_456',
      providerSubscriptionId: 'sub_123',
      productId: 'prod_pro',
      plan: 'pro',
      status: 'active',
      currentPeriodStart: new Date(1755000000 * 1000).toISOString(),
      currentPeriodEnd: new Date(1757592000 * 1000).toISOString(),
      cancelAtPeriodEnd: false,
      trialEnd: null,
    });
  });

  it('never stores card data — the snapshot shape has no payment-detail fields (spec T)', () => {
    const keys = Object.keys(snapshotFromStripeSubscription(stripeSub));
    for (const key of keys) {
      expect(key.toLowerCase()).not.toMatch(/card|cvv|pan|iban|account_number/);
    }
  });

  it('deleted events force the canceled terminal status', () => {
    const snapshot = snapshotFromStripeSubscription(
      { ...stripeSub, status: 'active' },
      { deleted: true }
    );
    expect(snapshot.status).toBe('canceled');
  });

  it('unknown statuses normalize to expired and grant no access', () => {
    const snapshot = snapshotFromStripeSubscription({ ...stripeSub, status: 'mystery' });
    expect(snapshot.status).toBe('expired');
    expect(
      grantsPaidAccess(
        {
          provider: 'stripe',
          status: snapshot.status,
          currentPeriodEnd: snapshot.currentPeriodEnd,
          cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
        },
        new Date()
      )
    ).toBe(false);
  });

  it('tolerates missing optional fields', () => {
    const snapshot = snapshotFromStripeSubscription({
      id: 'sub_x',
      customer: 'cus_x',
      status: 'trialing',
    });
    expect(snapshot.currentPeriodEnd).toBeNull();
    expect(snapshot.productId).toBeNull();
    expect(snapshot.cancelAtPeriodEnd).toBe(false);
  });
});

describe('CASE D: duplicate webhook idempotency (spec G)', () => {
  it('processes a first delivery and acknowledges duplicates without reprocessing', () => {
    const processed = new Set<string>();
    expect(shouldProcessEvent(processed, 'evt_1')).toBe(true);
    processed.add('evt_1');
    expect(shouldProcessEvent(processed, 'evt_1')).toBe(false);
    expect(shouldProcessEvent(processed, 'evt_2')).toBe(true);
  });
});

describe('CASE H: store adapter boundary (spec H/I/Q)', () => {
  it('the shipped stub reports not-configured honestly instead of faking store billing', async () => {
    expect(notConfiguredPurchases.isConfigured()).toBe(false);
    const purchase = await notConfiguredPurchases.purchasePro();
    expect(purchase.status).toBe('not_configured');
    const restore = await notConfiguredPurchases.restorePurchases();
    expect(restore.status).toBe('not_configured');
  });
});
