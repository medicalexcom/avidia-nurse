import { Slot } from 'expo-router';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { colors } from '../../src/ui/theme';

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
        <View style={styles.card}>
          <Slot />
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
  card: { width: '100%', maxWidth: 420 },
});
