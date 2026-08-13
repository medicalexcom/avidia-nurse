import { Slot } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { colors } from '../../src/ui/theme';

/** Centered card layout shared by the sign-in and sign-up screens. */
export default function AuthLayout() {
  return (
    <View style={styles.root}>
      <View style={styles.card}>
        <Slot />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  card: { width: '100%', maxWidth: 420 },
});
