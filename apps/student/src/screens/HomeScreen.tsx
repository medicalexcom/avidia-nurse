import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { env } from '../config/env';

/**
 * Minimal M0 home screen. Demonstrates the responsive-layout pattern the rest
 * of the app will follow: one component tree for iOS/Android/web, with layout
 * adapting to the available width (wide/desktop vs. narrow/mobile).
 */
export function HomeScreen() {
  const { width } = useWindowDimensions();
  const isWide = width >= 768;

  return (
    <View style={styles.root}>
      <View style={[styles.container, isWide ? styles.containerWide : null]}>
        <Text style={styles.title}>Avidia Nurse</Text>
        <Text style={styles.subtitle}>Adaptive nursing education platform</Text>
        <View style={[styles.cards, isWide ? styles.cardsWide : null]}>
          <InfoCard label="Milestone" value="M0 — Repository Bootstrap" />
          <InfoCard label="Environment" value={env.EXPO_PUBLIC_APP_ENV} />
          <InfoCard label="Layout" value={isWide ? 'Desktop / wide' : 'Mobile / narrow'} />
        </View>
      </View>
      <StatusBar style="auto" />
    </View>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>{label}</Text>
      <Text style={styles.cardValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#f5f7fa',
    alignItems: 'center',
    justifyContent: 'center',
  },
  container: {
    width: '100%',
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  containerWide: {
    maxWidth: 960,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: '#1a3c5e',
  },
  subtitle: {
    marginTop: 8,
    fontSize: 16,
    color: '#4a6786',
  },
  cards: {
    marginTop: 32,
    width: '100%',
    gap: 12,
  },
  cardsWide: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 20,
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 180,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  cardLabel: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#7b8ea3',
  },
  cardValue: {
    marginTop: 4,
    fontSize: 15,
    fontWeight: '600',
    color: '#1a3c5e',
  },
});
