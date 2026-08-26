import { Slot } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radius, shadow, spacing } from '../../src/ui/theme';

/**
 * Centered card layout shared by the sign-in and sign-up screens.
 *
 * KeyboardAvoidingView + ScrollView keep the email/password fields visible
 * above the soft keyboard on small phones (M15 spec C).
 */
export default function AuthLayout() {
  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.container}>
          <View style={styles.brandLockup}>
            <View style={styles.brandMark}>
              <Ionicons name="pulse" size={24} color="#ffffff" />
            </View>
            <View>
              <Text style={styles.brand}>Avidia</Text>
              <Text style={styles.brandSub}>NURSE</Text>
            </View>
          </View>
          <View style={styles.intro}>
            <Text style={styles.kicker}>YOUR CLINICAL STUDY SPACE</Text>
            <Text style={styles.introTitle}>Study with focus.</Text>
            <Text style={styles.introCopy}>
              Build a practice rhythm around the nursing concepts that matter most.
            </Text>
          </View>
          <View style={styles.card}>
            <Slot />
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  container: { width: '100%', maxWidth: 420 },
  brandLockup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(3),
    marginBottom: spacing(7),
  },
  brandMark: {
    width: 46,
    height: 46,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    ...shadow.md,
  },
  brand: { color: colors.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  brandSub: { color: colors.primary, fontSize: 10, fontWeight: '700', letterSpacing: 1.8 },
  intro: { marginBottom: spacing(6) },
  kicker: {
    color: colors.primary,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: spacing(2),
  },
  introTitle: {
    color: colors.text,
    fontSize: 30,
    fontWeight: '700',
    letterSpacing: -0.9,
    marginBottom: spacing(2),
  },
  introCopy: { color: colors.textMuted, fontSize: 15, lineHeight: 22, maxWidth: 330 },
  card: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing(6),
    ...shadow.md,
  },
});
