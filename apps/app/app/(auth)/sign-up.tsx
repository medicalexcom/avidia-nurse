import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';

import { useAuth } from '../../src/features/auth/AuthProvider';
import { ErrorBanner, Field, PrimaryButton } from '../../src/ui/components';
import { colors, spacing } from '../../src/ui/theme';

export default function SignUpScreen() {
  const { signUp, status } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);

  const backendUnavailable = status === 'unavailable';

  const onSubmit = async () => {
    setError(null);
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setError('Please choose a longer password (at least 8 characters).');
      return;
    }
    setBusy(true);
    const failure = await signUp(email.trim(), password);
    setBusy(false);
    if (failure) {
      setError(failure.message);
      return;
    }
    // If email confirmation is enabled on the project, there is no session
    // yet; tell the student what to do. If it is disabled, the auth listener
    // signs them straight in and the root layout redirects.
    setConfirmationSent(true);
  };

  if (confirmationSent && status !== 'signed-in') {
    return (
      <View>
        <Text style={styles.heading}>Check your email</Text>
        <Text style={styles.sub}>
          We sent a confirmation link to {email.trim()}. Confirm your address, then come back and
          sign in.
        </Text>
        <Link href="/sign-in" style={styles.link}>
          Back to sign in
        </Link>
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.heading}>Create your account</Text>
      <Text style={styles.sub}>Start studying smarter for nursing school.</Text>
      <ErrorBanner
        message={
          backendUnavailable
            ? 'Sign-up is not available right now. Please try again later or contact support.'
            : error
        }
      />
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        placeholder="you@example.com"
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
        placeholder="At least 8 characters"
      />
      <Field
        label="Confirm password"
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        autoComplete="new-password"
        placeholder="Repeat your password"
      />
      <PrimaryButton
        label="Create account"
        onPress={onSubmit}
        busy={busy}
        disabled={backendUnavailable || !email.trim() || !password || !confirm}
      />
      <Text style={styles.footer}>
        Already have an account?{' '}
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
