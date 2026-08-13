import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';

import { getSupabase } from '../../lib/supabase';
import { mapAuthError, authErrorFor, type UserSafeAuthError } from './errors';
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
}

const AuthContext = createContext<AuthContextValue | null>(null);

function toAuthUser(session: Session | null): AuthUser | null {
  if (!session?.user) return null;
  return { id: session.user.id, email: session.user.email ?? null };
}

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

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        setUser(toAuthUser(data.session));
        setStatus(data.session ? 'signed-in' : 'signed-out');
      })
      .catch(() => {
        if (cancelled) return;
        // Persisted session could not be read — treat as signed out rather
        // than blocking the app.
        setUser(null);
        setStatus('signed-out');
      });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      setUser(toAuthUser(session));
      setStatus(session ? 'signed-in' : 'signed-out');
    });

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
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

  const value = useMemo(
    () => ({ status, user, signUp, signIn, signOut }),
    [status, user, signUp, signIn, signOut]
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
