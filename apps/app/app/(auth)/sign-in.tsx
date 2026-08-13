import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';

import { useAuth } from '../../src/features/auth/AuthProvider';
import { ErrorBanner, Field, PrimaryButton } from '../../src/ui/components';
import { colors, spacing } from '../../src/ui/theme';

export default function SignInScreen() {
  const { signIn, status } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const backendUnavailable = status === 'unavailable';

  const onSubmit = async () => {
    setError(null);
    setBusy(true);
    const failure = await signIn(email.trim(), password);
    setBusy(false);
    if (failure) setError(failure.message);
    // On success the auth listener updates status and the root layout
    // redirects into the shell.
  };

  return (
    <View>
      <Text style={styles.heading}>Welcome back</Text>
      <Text style={styles.sub}>Sign in to continue studying.</Text>
      <ErrorBanner
        message={
          backendUnavailable
            ? 'Sign-in is not available right now. Please try again later or contact support.'
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
        autoComplete="current-password"
        placeholder="Your password"
      />
      <PrimaryButton
        label="Sign in"
        onPress={onSubmit}
        busy={busy}
        disabled={backendUnavailable || !email.trim() || !password}
      />
      <Text style={styles.footer}>
        New to Avidia Nurse?{' '}
        <Link href="/sign-up" style={styles.link}>
          Create an account
        </Link>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 26, fontWeight: '700', color: colors.text, marginBottom: spacing(1) },
  sub: { fontSize: 15, color: colors.textMuted, marginBottom: spacing(5) },
  footer: { marginTop: spacing(5), color: colors.textMuted, fontSize: 14, textAlign: 'center' },
  link: { color: colors.primary, fontWeight: '600' },
});
