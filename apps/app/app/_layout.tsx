import { useEffect } from 'react';
import { Slot, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from '../src/features/auth/AuthProvider';
import { decideRoute, routeGroupFromSegments } from '../src/features/auth/guards';
import { LoadingScreen } from '../src/ui/components';

/**
 * Root layout: provides auth state and enforces protected routing.
 * The actual redirect rules live in decideRoute (pure, unit-tested).
 */
function AuthGate() {
  const { status } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  const decision = decideRoute(status, routeGroupFromSegments(segments));

  useEffect(() => {
    if (decision.action === 'redirect') {
      router.replace(decision.to);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision.action, decision.action === 'redirect' ? decision.to : null]);

  if (decision.action === 'show-loading') {
    return <LoadingScreen label="Signing you in…" />;
  }
  return <Slot />;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="dark" />
        <AuthGate />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
