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
import { Ionicons } from '@expo/vector-icons';

import { colors, radius, sectionAccents, shadow, spacing, type, type SectionKey } from './theme';

/**
 * `section`/`icon` are optional: most screens still render a plain title.
 * Passing them adds a colored icon chip beside it — used on the screens
 * that used to be visually indistinguishable "pick a course" lists (Study,
 * Weaknesses, Progress) so each reads as its own place.
 */
export function Screen({
  title,
  section,
  icon,
  children,
}: {
  title: string;
  section?: SectionKey;
  icon?: keyof typeof Ionicons.glyphMap;
  children?: ReactNode;
}) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>
      {section && icon ? (
        <View style={styles.screenHeading}>
          <SectionIcon section={section} name={icon} size={22} />
          <Text style={styles.screenHeadingTitle}>{title}</Text>
        </View>
      ) : (
        <Text style={styles.title}>{title}</Text>
      )}
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
      <Pill label="Not yet available" tone="neutral" style={styles.pillSpacer} />
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
        placeholderTextColor={colors.textFaint}
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

export function SecondaryButton({
  label,
  onPress,
  disabled,
  destructive,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.secondaryButton,
        disabled && styles.buttonDisabled,
        pressed && styles.secondaryButtonPressed,
      ]}
    >
      <Text style={[styles.secondaryButtonLabel, destructive && styles.destructiveLabel]}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Inline destructive confirmation (works identically on native and web,
 * unlike Alert.alert). Explains exactly what will be deleted before letting
 * the user confirm.
 */
export function ConfirmInline({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <View style={styles.confirmBox} accessibilityRole="alert">
      <Text style={styles.confirmText}>{message}</Text>
      <View style={styles.confirmActions}>
        <SecondaryButton label="Cancel" onPress={onCancel} />
        <SecondaryButton label={confirmLabel} onPress={onConfirm} destructive />
      </View>
    </View>
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

/** Elevated content block — the one shared "card" surface for new screens. */
export function Card({ children, style }: { children?: ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

type PillTone = 'neutral' | 'info' | 'good' | 'warn' | 'critical';

const PILL_TONES: Record<PillTone, { bg: string; fg: string }> = {
  neutral: { bg: colors.badge, fg: colors.badgeText },
  info: { bg: sectionAccents.home.soft, fg: sectionAccents.home.accent },
  good: { bg: colors.goodSoft, fg: colors.good },
  warn: { bg: sectionAccents.weaknesses.soft, fg: sectionAccents.weaknesses.accent },
  critical: { bg: colors.dangerSoft, fg: colors.danger },
};

/** Small status/label chip. Generalizes the old one-off "badge" style. */
export function Pill({
  label,
  tone = 'neutral',
  style,
}: {
  label: string;
  tone?: PillTone;
  style?: object;
}) {
  const t = PILL_TONES[tone];
  return (
    <View style={[styles.pill, { backgroundColor: t.bg }, style]}>
      <Text style={[styles.pillText, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

/** Circular tinted icon chip, colored by section accent. */
export function SectionIcon({
  section,
  name,
  size = 20,
}: {
  section: SectionKey;
  name: keyof typeof Ionicons.glyphMap;
  size?: number;
}) {
  const { accent, soft } = sectionAccents[section];
  const box = size + 20;
  return (
    <View
      style={[
        styles.sectionIcon,
        { backgroundColor: soft, width: box, height: box, borderRadius: box / 2 },
      ]}
    >
      <Ionicons name={name} size={size} color={accent} />
    </View>
  );
}

/**
 * One row in a "pick a course" list — used by Study, Weaknesses, and
 * Progress, which all land on the same course-chooser shape. Colored by
 * section so the same layout still reads as three different places.
 */
export function CourseListRow({
  section,
  icon,
  title,
  meta,
  onPress,
}: {
  section: SectionKey;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  meta?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => [styles.courseRow, pressed && styles.courseRowPressed]}
    >
      <SectionIcon section={section} name={icon} size={18} />
      <View style={styles.courseRowText}>
        <Text style={styles.courseRowTitle}>{title}</Text>
        {meta ? <Text style={styles.courseRowMeta}>{meta}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  screenContent: { padding: spacing(6), maxWidth: 720, width: '100%', alignSelf: 'center' },
  title: { ...type.display, color: colors.text, marginBottom: spacing(4) },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing(3),
    backgroundColor: colors.background,
  },
  loadingLabel: { color: colors.textMuted, fontSize: 14 },
  muted: { color: colors.textMuted, fontSize: 15, lineHeight: 22 },
  field: { marginBottom: spacing(4) },
  fieldLabel: { ...type.label, color: colors.text, marginBottom: spacing(1.5) },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2.5),
    fontSize: 15,
    color: colors.text,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    alignItems: 'center',
    paddingVertical: spacing(3),
    marginTop: spacing(2),
  },
  buttonDisabled: { opacity: 0.5 },
  buttonPressed: { backgroundColor: colors.primaryDark },
  buttonLabel: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  errorBanner: {
    backgroundColor: colors.dangerSoft,
    borderColor: '#fecaca',
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: spacing(3),
    marginBottom: spacing(4),
  },
  errorText: { color: colors.danger, fontSize: 14 },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    alignItems: 'center',
    paddingVertical: spacing(2),
    paddingHorizontal: spacing(3),
  },
  secondaryButtonPressed: { backgroundColor: colors.background },
  secondaryButtonLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  destructiveLabel: { color: colors.danger },
  confirmBox: {
    backgroundColor: '#fffbeb',
    borderColor: '#fde68a',
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: spacing(3),
    marginVertical: spacing(2),
    gap: spacing(2),
  },
  confirmText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  confirmActions: { flexDirection: 'row', gap: spacing(2), justifyContent: 'flex-end' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing(4),
    ...shadow.sm,
  },
  pill: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(1),
  },
  pillSpacer: { marginBottom: spacing(3) },
  pillText: { ...type.caption, fontWeight: '600' },
  sectionIcon: { alignItems: 'center', justifyContent: 'center' },
  screenHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(3),
    marginBottom: spacing(5),
  },
  screenHeadingTitle: { ...type.title, color: colors.text, flex: 1 },
  courseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(3),
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing(3.5),
    marginBottom: spacing(2.5),
    ...shadow.sm,
  },
  courseRowPressed: { backgroundColor: colors.surfaceSunken },
  courseRowText: { flex: 1, gap: 2 },
  courseRowTitle: { ...type.heading, color: colors.text },
  courseRowMeta: { ...type.caption, color: colors.textMuted },
});
