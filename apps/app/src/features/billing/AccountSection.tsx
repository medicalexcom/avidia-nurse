import { useState } from 'react';
import { Linking, Platform, Share, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { getSupabase } from '../../lib/supabase';
import { trackEvent } from '../../lib/analytics';
import { useAuth } from '../auth/AuthProvider';
import { deleteMyAccount, exportMyData, openBillingPortal } from './billingApi';
import { useEntitlements } from './useEntitlements';
import { ConfirmInline, ErrorBanner, SecondaryButton } from '../../ui/components';
import { colors, spacing } from '../../ui/theme';

/**
 * Profile → Subscription & account section (M14 spec M/R/AK/AL).
 *
 * - Shows the current plan (server-resolved) and, for Stripe subscribers,
 *   opens Stripe's hosted billing portal for payment method / cancellation /
 *   invoices — we build no custom card UI (spec R/T).
 * - "Download my data" calls export_my_data() and hands the JSON to the
 *   platform share/download affordance (spec AK).
 * - "Delete my account" is a guarded, inline-confirmed, irreversible action;
 *   the server refuses while a web subscription would keep charging
 *   (spec AL — billing implication documented in ADR-0039).
 */
export function AccountSection() {
  const { user, signOut } = useAuth();
  const router = useRouter();
  const { entitlements, fromCache } = useEntitlements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const plan = entitlements?.plan ?? null;
  const hasStripeSub = (entitlements?.subscriptions ?? []).some((s) => s.provider === 'stripe');

  const onManageBilling = async () => {
    const client = getSupabase();
    if (!client) return;
    setBusy(true);
    setError(null);
    trackEvent({ name: 'billing_portal_opened' });
    try {
      const result = await openBillingPortal(client);
      if (result.status === 'ok') {
        await Linking.openURL(result.url);
      } else if (result.status === 'no_billing_account') {
        setNotice('No web subscription found for this account.');
      } else if (result.status === 'not_configured') {
        setNotice('Billing is not enabled yet.');
      } else {
        setError('Could not open the billing portal. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const onExport = async () => {
    const client = getSupabase();
    if (!client) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    trackEvent({ name: 'data_export_requested' });
    try {
      const data = await exportMyData(client);
      const json = JSON.stringify(data, null, 2);
      if (Platform.OS === 'web') {
        // Browser download; no server round-trip beyond the RPC itself.
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'avidia-data-export.json';
        anchor.click();
        URL.revokeObjectURL(url);
      } else {
        await Share.share({ message: json });
      }
      setNotice('Your data export is ready.');
    } catch {
      setError('Export failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    const client = getSupabase();
    if (!client || !user) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    trackEvent({ name: 'account_deletion_requested' });
    try {
      const result = await deleteMyAccount(client);
      if (result.status === 'deleted') {
        await signOut();
      } else if (result.status === 'active_subscription') {
        setError(
          'You still have an active subscription. Cancel it first (Manage subscription), then delete your account.'
        );
      } else {
        setError(result.message);
      }
    } finally {
      setBusy(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <View style={styles.section} testID="account-section">
      <Text style={styles.heading}>Subscription & account</Text>
      <ErrorBanner message={error} testID="account-error" />
      {notice ? <Text testID="account-notice" style={styles.notice}>{notice}</Text> : null}

      <Text style={styles.planLine} testID="plan-line">
        Plan: {plan === 'pro' ? 'PRO' : plan === 'free' ? 'Free' : '—'}
        {fromCache ? ' (offline — last known)' : ''}
      </Text>

      {plan === 'pro' && hasStripeSub ? (
        <SecondaryButton
          testID="manage-subscription-button"
          label="Manage subscription"
          onPress={onManageBilling}
          disabled={busy}
        />
      ) : (
        <SecondaryButton
          testID="upgrade-button"
          label="Upgrade to PRO"
          onPress={() => router.push('/upgrade')}
          disabled={busy}
        />
      )}

      <SecondaryButton
        testID="export-data-button"
        label="Download my data"
        onPress={onExport}
        disabled={busy}
      />

      {confirmingDelete ? (
        <ConfirmInline
          message={
            'Delete your account? This permanently removes your courses, uploads, study history and profile. This cannot be undone.'
          }
          confirmLabel="Delete my account"
          onConfirm={onDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      ) : (
        <SecondaryButton
          testID="delete-account-button"
          label="Delete my account"
          destructive
          onPress={() => setConfirmingDelete(true)}
          disabled={busy}
        />
      )}
      <View style={styles.legal} testID="legal-section">
        {/* Spec AO: the educational disclaimer, shown plainly. */}
        <Text style={styles.legalText}>
          Avidia Nurse is a study tool for nursing education. It is not medical advice and must not
          be used to make clinical decisions about real patients.
        </Text>
        {/* Spec AN: placeholder legal surfaces — explicitly marked as pending
            legal review; final documents must come from counsel before launch. */}
        <Text style={styles.legalText}>
          Privacy Policy and Terms of Service: drafts pending legal review — final versions will
          appear here before public launch.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing(6), gap: spacing(2) },
  heading: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: spacing(1) },
  planLine: { fontSize: 14, color: colors.textMuted, marginBottom: spacing(2) },
  notice: { color: '#15803d', fontSize: 14, marginBottom: spacing(2) },
  legal: {
    marginTop: spacing(6),
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing(4),
    gap: spacing(2),
  },
  legalText: { fontSize: 12, color: colors.textMuted, lineHeight: 18 },
});
