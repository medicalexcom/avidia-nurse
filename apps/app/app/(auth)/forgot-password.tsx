import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';

import { useAuth } from '../../src/features/auth/AuthProvider';
import { ErrorBanner, Field, PrimaryButton } from '../../src/ui/components';
import { colors, spacing } from '../../src/ui/theme';

export default function ForgotPasswordScreen() {
  const { requestPasswordReset, status } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const backendUnavailable = status === 'unavailable';

  const onSubmit = async () => {
    setError(null);
    setBusy(true);
    const failure = await requestPasswordReset(email.trim());
    setBusy(false);
    if (failure) {
      setError(failure.message);
      return;
    }
    // Supabase never reveals whether the address has an account, so the same
    // "check your email" message is shown either way.
    setSent(true);
  };

  if (sent) {
    return (
      <View>
        <Text style={styles.heading}>Check your email</Text>
        <Text style={styles.sub}>
          If an account exists for {email.trim()}, we sent a link to reset the password. Follow it
          to choose a new one.
        </Text>
        <Link href="/sign-in" style={styles.link}>
          Back to sign in
        </Link>
      </View>
    );
  }

  return (
    <View testID="auth-container">
      <Text style={styles.heading}>Reset your password</Text>
      <Text style={styles.sub}>
        Enter the email address on your account and we&apos;ll send you a link to choose a new
        password.
      </Text>
      <ErrorBanner
        testID="error-message"
        message={
          backendUnavailable
            ? 'Password reset is not available right now. Please try again later or contact support.'
            : error
        }
      />
      <Field
        label="Email"
        testID="reset-email-input"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        placeholder="you@example.com"
      />
      <PrimaryButton
        testID="send-reset-link-button"
        label="Send reset link"
        onPress={onSubmit}
        busy={busy}
        disabled={backendUnavailable || !email.trim()}
      />
      <Text style={styles.footer}>
        Remembered your password?{' '}
        <Link href="/sign-in" style={styles.link}>
          Sign in
        </Link>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 26, fontWeight: '700', color: colors.text, marginBottom: spacing(1) },
  sub: { fontSize: 15, color: colors.textMuted, marginBottom: spacing(5), lineHeight: 22 },
  footer: { marginTop: spacing(5), color: colors.textMuted, fontSize: 14, textAlign: 'center' },
  link: { color: colors.primary, fontWeight: '600' },
});
