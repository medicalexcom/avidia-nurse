import { Slot } from 'expo-router';

import { ResponsiveShell } from '../../src/ui/ResponsiveShell';

/**
 * Protected group layout. Unauthenticated users never reach this render:
 * the root layout's AuthGate redirects them to /sign-in first.
 */
export default function AppLayout() {
  return (
    <ResponsiveShell>
      <Slot />
    </ResponsiveShell>
  );
}
