import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../src/features/auth/AuthProvider';
import { Screen } from '../../src/ui/components';
import { colors, spacing } from '../../src/ui/theme';

export default function HomeScreen() {
  const { user } = useAuth();
  return (
    <Screen title="Home">
      <Text style={styles.welcome}>
        Welcome{user?.email ? `, ${user.email}` : ''}. You are signed in.
      </Text>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>What&apos;s next</Text>
        <Text style={styles.cardBody}>
          Courses, adaptive study sessions, weakness tracking, and progress analytics arrive in
          upcoming milestones. Use the navigation to explore the app shell — placeholder areas are
          clearly marked.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  welcome: { fontSize: 15, color: colors.textMuted, marginBottom: spacing(4) },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(4),
  },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.text, marginBottom: spacing(2) },
  cardBody: { fontSize: 14, color: colors.textMuted, lineHeight: 21 },
});
