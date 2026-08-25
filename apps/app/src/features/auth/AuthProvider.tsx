import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import type { Session, SupabaseClient } from '@supabase/supabase-js';

import { getSupabase } from '../../lib/supabase';
import { env } from '../../config/env';
import { mapAuthError, authErrorFor, type UserSafeAuthError } from './errors';
import { buildRecoveryRedirectUrl, isPasswordRecoveryUrl } from './recoveryLink';
import type { AuthStatus } from './guards';

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface AuthContextValue {
  /** Lifecycle status driving all protected-route decisions. */
  status: AuthStatus;
  user: AuthUser | null;
  signUp(email: string, password: string): Promise<UserSafeAuthError | null>;
  signIn(email: string, password: string): Promise<UserSafeAuthError | null>;
  signOut(): Promise<UserSafeAuthError | null>;
  /** Sends a password-recovery email; never reveals whether the address has an account. */
  requestPasswordReset(email: string): Promise<UserSafeAuthError | null>;
  /** Sets a new password for the active recovery session, then promotes status to 'signed-in'. */
  updatePassword(newPassword: string): Promise<UserSafeAuthError | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function toAuthUser(session: Session | null): AuthUser | null {
  if (!session?.user) return null;
  return { id: session.user.id, email: session.user.email ?? null };
}

/**
 * Captured once, at module load — i.e. before the Supabase client (created
 * lazily on AuthProvider's first render) exists and can rewrite the URL
 * while detecting a session from it. `window` is undefined outside the
 * browser (native, Jest), so this is `null` there; native recovery links are
 * instead read from `Linking` inside the effect below.
 */
const initialUrl = typeof window !== 'undefined' && window.location ? window.location.href : null;

export interface AuthProviderProps {
  children: ReactNode;
  /** Injectable for tests; defaults to the real singleton. */
  client?: SupabaseClient | null;
}

export function AuthProvider({ children, client }: AuthProviderProps) {
  const supabase = client !== undefined ? client : getSupabase();
  const [status, setStatus] = useState<AuthStatus>(supabase ? 'restoring' : 'unavailable');
  const [user, setUser] = useState<AuthUser | null>(null);

  // Session restoration + auth-state listener.
  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    // Whether this mount began from a password-recovery link. Checked from
    // three independent sources (module-load-time URL capture, a native
    // deep link, and Supabase's own PASSWORD_RECOVERY event) since no single
    // one is reliable on every platform — see recoveryLink.ts.
    let isRecoveryFlow = isPasswordRecoveryUrl(initialUrl);

    const settle = (session: Session | null) => {
      if (cancelled) return;
      setUser(toAuthUser(session));
      setStatus(session ? (isRecoveryFlow ? 'recovery' : 'signed-in') : 'signed-out');
    };

    const restore = async () => {
      if (!isRecoveryFlow && Platform.OS !== 'web') {
        const nativeUrl = await Linking.getInitialURL();
        if (isPasswordRecoveryUrl(nativeUrl)) isRecoveryFlow = true;
      }
      try {
        const { data } = await supabase.auth.getSession();
        settle(data.session);
      } catch {
        if (cancelled) return;
        // Persisted session could not be read — treat as signed out rather
        // than blocking the app.
        setUser(null);
        setStatus('signed-out');
      }
    };
    restore();

    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;
      if (event === 'PASSWORD_RECOVERY') isRecoveryFlow = true;
      settle(session);
    });

    // Native only: catches the link when the app is already running in the
    // background (a cold start is covered by Linking.getInitialURL above).
    const linkingSubscription =
      Platform.OS !== 'web'
        ? Linking.addEventListener('url', ({ url }) => {
            if (isPasswordRecoveryUrl(url)) isRecoveryFlow = true;
          })
        : null;

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
      linkingSubscription?.remove();
    };
  }, [supabase]);

  const signUp = useCallback(
    async (email: string, password: string) => {
      if (!supabase) return authErrorFor('backend-unavailable');
      try {
        const { error } = await supabase.auth.signUp({ email, password });
        return error ? mapAuthError(error) : null;
      } catch (err) {
        return mapAuthError(err);
      }
    },
    [supabase]
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!supabase) return authErrorFor('backend-unavailable');
      try {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return error ? mapAuthError(error) : null;
      } catch (err) {
        return mapAuthError(err);
      }
    },
    [supabase]
  );

  const signOut = useCallback(async () => {
    if (!supabase) return authErrorFor('backend-unavailable');
    try {
      const { error } = await supabase.auth.signOut();
      if (error) return mapAuthError(error);
      // The listener also fires, but update immediately for responsiveness.
      setUser(null);
      setStatus('signed-out');
      return null;
    } catch (err) {
      return mapAuthError(err);
    }
  }, [supabase]);

  const requestPasswordReset = useCallback(
    async (email: string) => {
      if (!supabase) return authErrorFor('backend-unavailable');
      try {
        const redirectTo = buildRecoveryRedirectUrl({
          platform: Platform.OS,
          webAppUrl: env.EXPO_PUBLIC_WEB_APP_URL,
          windowOrigin:
            typeof window !== 'undefined' && window.location ? window.location.origin : undefined,
          createNativeUrl: () => Linking.createURL('reset-password'),
        });
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
        return error ? mapAuthError(error) : null;
      } catch (err) {
        return mapAuthError(err);
      }
    },
    [supabase]
  );

  const updatePassword = useCallback(
    async (newPassword: string) => {
      if (!supabase) return authErrorFor('backend-unavailable');
      try {
        const { error } = await supabase.auth.updateUser({ password: newPassword });
        if (error) return mapAuthError(error);
        // The recovery session is now an ordinary authenticated session —
        // the guard moves the student into the shell from here.
        setStatus('signed-in');
        return null;
      } catch (err) {
        return mapAuthError(err);
      }
    },
    [supabase]
  );

  const value = useMemo(
    () => ({ status, user, signUp, signIn, signOut, requestPasswordReset, updatePassword }),
    [status, user, signUp, signIn, signOut, requestPasswordReset, updatePassword]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
