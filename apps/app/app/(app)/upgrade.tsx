import { useEffect, useState } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';

import { getSupabase } from '../../src/lib/supabase';
import { trackEvent } from '../../src/lib/analytics';
import { startCheckout } from '../../src/features/billing/billingApi';
import { purchases } from '../../src/features/billing/purchases';
import { useEntitlements } from '../../src/features/billing/useEntitlements';
import { ErrorBanner, PrimaryButton, Screen, SecondaryButton } from '../../src/ui/components';
import { colors, spacing } from '../../src/ui/theme';

/**
 * The paywall (M14 spec M/N/Q) — restrained by design. It states what PRO
 * adds, what FREE keeps (the core adaptive loop is never paywalled), and the
 * facts a student needs before paying: price shown at Stripe checkout,
 * monthly renewal, cancel anytime in the billing portal, learning data kept
 * on downgrade. Checkout itself happens on Stripe-hosted pages (spec R/T) —
 * this screen never sees payment details.
 */

const PRO_FEATURES = [
  'Advanced study modes (Rapid Response, Boss Battle and more)',
  'The intelligent study planner with reminders',
  'Unlimited courses, uploads and patient simulations',
];

const FREE_KEEPS = [
  'Adaptive daily study on your active course',
  'Your uploads, mastery history and analytics — nothing is ever deleted',
];

export default function UpgradeScreen() {
  const { entitlements, loading } = useEntitlements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    trackEvent({ name: 'paywall_viewed' });
  }, []);

  const isPro = entitlements?.plan === 'pro';

  const onUpgrade = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    trackEvent({ name: 'checkout_started' });
    try {
      if (Platform.OS !== 'web') {
        // Native builds must use store billing (spec H). Not configured yet —
        // say so honestly instead of faking a flow (spec I).
        const outcome = await purchases.purchasePro();
        if (outcome.status === 'not_configured') {
          setNotice(
            'Purchases are not available in this build yet. You can subscribe on the web at your account page.'
          );
        } else if (outcome.status === 'error') {
          setError(outcome.message);
        }
        return;
      }
      const client = getSupabase();
      if (!client) {
        setError('You need to be signed in to upgrade.');
        return;
      }
      const result = await startCheckout(client);
      if (result.status === 'ok') {
        await Linking.openURL(result.url);
      } else if (result.status === 'not_configured') {
        setNotice('Billing is not enabled yet — PRO will be available soon.');
      } else {
        setError('Could not start checkout. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    trackEvent({ name: 'restore_purchases_attempted' });
    try {
      const outcome = await purchases.restorePurchases();
      if (outcome.status === 'not_configured') {
        setNotice('Purchases are not available in this build yet, so there is nothing to restore.');
      } else if (outcome.status === 'restored') {
        setNotice('Purchases restored.');
      } else if (outcome.status === 'nothing_to_restore') {
        setNotice('No previous purchases found for this account.');
      } else if (outcome.status === 'error') {
        setError(outcome.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Avidia PRO">
      <ErrorBanner message={error} />
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      {isPro ? (
        <Text style={styles.proBadge} testID="pro-active">
          You’re on PRO — every feature is unlocked. Manage your subscription from your profile.
        </Text>
      ) : (
        <View>
          <Text style={styles.heading}>PRO adds</Text>
          {PRO_FEATURES.map((line) => (
            <Text key={line} style={styles.item}>
              • {line}
            </Text>
          ))}
          <Text style={styles.heading}>Free always keeps</Text>
          {FREE_KEEPS.map((line) => (
            <Text key={line} style={styles.item}>
              • {line}
            </Text>
          ))}
          <Text style={styles.terms}>
            PRO is a monthly subscription that renews automatically until you cancel. The exact
            price and any applicable tax are shown before you pay, on Stripe’s secure checkout page.
            Cancel anytime from your profile — you keep PRO until the end of the period you’ve paid
            for, and all of your learning data stays either way.
          </Text>
          <PrimaryButton
            label={busy ? 'One moment…' : 'Continue to checkout'}
            onPress={onUpgrade}
            disabled={busy || loading}
          />
          {Platform.OS !== 'web' ? (
            <SecondaryButton label="Restore purchases" onPress={onRestore} disabled={busy} />
          ) : null}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    marginTop: spacing(4),
    marginBottom: spacing(1),
  },
  item: {
    fontSize: 14,
    color: colors.text,
    marginBottom: spacing(1),
    lineHeight: 20,
  },
  terms: {
    fontSize: 12,
    color: colors.textMuted,
    marginVertical: spacing(4),
    lineHeight: 18,
  },
  notice: {
    fontSize: 14,
    color: colors.text,
    backgroundColor: colors.surface,
    borderRadius: 8,
    padding: spacing(3),
    marginBottom: spacing(3),
  },
  proBadge: {
    fontSize: 14,
    color: colors.text,
    lineHeight: 20,
    marginTop: spacing(4),
  },
});
