import { useEffect } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';

import { safeDeepLink } from './notifications';

/**
 * Navigate when the student taps a local reminder — M13 (spec AG).
 *
 * The destination comes from the notification payload but is validated
 * against a small allowlist before navigating; anything unexpected lands on
 * home instead of crashing or leaving the app on a broken route. Web mounts
 * nothing (spec AI — no local notifications there).
 */
export function useNotificationDeepLinks(): void {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const notifications = await import('expo-notifications');
        if (cancelled) return;
        const subscription = notifications.addNotificationResponseReceivedListener((response) => {
          const url = response.notification.request.content.data?.url;
          router.push(safeDeepLink(url) as never);
        });
        unsubscribe = () => subscription.remove();
      } catch {
        // Notifications unavailable — deep links simply do nothing.
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
}
