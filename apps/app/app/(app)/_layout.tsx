import { Slot } from 'expo-router';

import { useNotificationDeepLinks } from '../../src/features/planner/useNotificationDeepLinks';
import { ResponsiveShell } from '../../src/ui/ResponsiveShell';

/**
 * Protected group layout. Unauthenticated users never reach this render:
 * the root layout's AuthGate redirects them to /sign-in first.
 */
export default function AppLayout() {
  // M13 spec AG: reminder taps deep-link into the app (validated, native-only).
  useNotificationDeepLinks();
  return (
    <ResponsiveShell>
      <Slot />
    </ResponsiveShell>
  );
}
