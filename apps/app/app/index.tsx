import { Redirect } from 'expo-router';

import { useAuth } from '../src/features/auth/AuthProvider';

/** Entry route: forward to the shell or the sign-in screen. */
export default function Index() {
  const { status } = useAuth();
  if (status === 'signed-in') return <Redirect href="/home" />;
  return <Redirect href="/sign-in" />;
}
