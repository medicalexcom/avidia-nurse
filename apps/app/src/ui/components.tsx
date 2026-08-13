import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

import { colors, spacing } from './theme';

export function Screen({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>
      <Text style={styles.title}>{title}</Text>
      {children}
    </ScrollView>
  );
}

/** Full-screen loading state (used during session restoration). */
export function LoadingScreen({ label }: { label: string }) {
  return (
    <View style={styles.loading} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator size="large" color={colors.primary} />
      <Text style={styles.loadingLabel}>{label}</Text>
    </View>
  );
}

/** Placeholder destination for a future milestone — clearly labeled as such. */
export function PlaceholderScreen({ title, milestone }: { title: string; milestone: string }) {
  return (
    <Screen title={title}>
      <View style={styles.badge}>
        <Text style={styles.badgeText}>Not yet available</Text>
      </View>
      <Text style={styles.muted}>
        {title} is planned for a later milestone ({milestone}). Nothing here is functional yet —
        this destination only reserves its place in the app&apos;s navigation.
      </Text>
    </Screen>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const { label, ...inputProps } = props;
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.textMuted}
        style={styles.input}
        accessibilityLabel={label}
        {...inputProps}
      />
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  busy,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        (disabled || busy) && styles.buttonDisabled,
        pressed && styles.buttonPressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color="#ffffff" />
      ) : (
        <Text style={styles.buttonLabel}>{label}</Text>
      )}
    </Pressable>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View style={styles.errorBanner} accessibilityRole="alert">
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  screenContent: { padding: spacing(6), maxWidth: 720, width: '100%', alignSelf: 'center' },
  title: { fontSize: 24, fontWeight: '700', color: colors.text, marginBottom: spacing(4) },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing(3),
    backgroundColor: colors.background,
  },
  loadingLabel: { color: colors.textMuted, fontSize: 14 },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.badge,
    borderRadius: 999,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(1),
    marginBottom: spacing(3),
  },
  badgeText: { color: colors.badgeText, fontSize: 12, fontWeight: '600' },
  muted: { color: colors.textMuted, fontSize: 15, lineHeight: 22 },
  field: { marginBottom: spacing(4) },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: spacing(1.5) },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2.5),
    fontSize: 15,
    color: colors.text,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: 8,
    alignItems: 'center',
    paddingVertical: spacing(3),
    marginTop: spacing(2),
  },
  buttonDisabled: { opacity: 0.5 },
  buttonPressed: { backgroundColor: colors.primaryDark },
  buttonLabel: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  errorBanner: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing(3),
    marginBottom: spacing(4),
  },
  errorText: { color: colors.danger, fontSize: 14 },
});
