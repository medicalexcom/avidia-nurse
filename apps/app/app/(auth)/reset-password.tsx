import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';

import { useAuth } from '../../src/features/auth/AuthProvider';
import { ErrorBanner, Field, PrimaryButton } from '../../src/ui/components';
import { colors, spacing } from '../../src/ui/theme';

export default function ResetPasswordScreen() {
  const { status, updatePassword } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Sticky once true: after updatePassword succeeds, status flips to
  // 'signed-in' and the root layout redirects into the shell a tick later.
  // Without this flag that same status change would briefly re-render this
  // screen as "not a recovery session" and flash the invalid-link message.
  const [done, setDone] = useState(false);

  if (status !== 'recovery' && !done) {
    return (
      <View>
        <Text style={styles.heading}>This link isn&apos;t valid</Text>
        <Text style={styles.sub}>
          Password reset links expire after a while and can only be used once. Request a new one to
          continue.
        </Text>
        <Link href="/forgot-password" style={styles.link}>
          Send a new reset link
        </Link>
      </View>
    );
  }

  if (done) {
    return (
      <View>
        <Text style={styles.heading}>Password updated</Text>
        <Text style={styles.sub}>Your password has been changed. Taking you in now…</Text>
      </View>
    );
  }

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
    const failure = await updatePassword(password);
    setBusy(false);
    if (failure) {
      setError(failure.message);
      return;
    }
    // The auth listener already moved status to 'signed-in'; the root
    // layout's guard redirects into the shell from here.
    setDone(true);
  };

  return (
    <View>
      <Text style={styles.heading}>Choose a new password</Text>
      <Text style={styles.sub}>Pick something you haven&apos;t used before on this account.</Text>
      <ErrorBanner message={error} />
      <Field
        label="New password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
        placeholder="At least 8 characters"
      />
      <Field
        label="Confirm new password"
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        autoComplete="new-password"
        placeholder="Repeat your new password"
      />
      <PrimaryButton
        label="Update password"
        onPress={onSubmit}
        busy={busy}
        disabled={!password || !confirm}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 26, fontWeight: '700', color: colors.text, marginBottom: spacing(1) },
  sub: { fontSize: 15, color: colors.textMuted, marginBottom: spacing(5), lineHeight: 22 },
  link: { color: colors.primary, fontWeight: '600' },
});
