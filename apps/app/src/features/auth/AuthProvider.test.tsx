import { Text } from 'react-native';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import type { Session, SupabaseClient } from '@supabase/supabase-js';

import { AuthProvider, useAuth } from './AuthProvider';

// expo-linking's real createURL reads the Expo Constants manifest to resolve
// the app's URI scheme, which isn't populated under Jest — mock the whole
// module for deterministic, environment-independent behavior instead.
jest.mock('expo-linking', () => ({
  createURL: jest.fn((path: string) => `avidianurse:///${path}`),
  getInitialURL: jest.fn().mockResolvedValue(null),
  addEventListener: jest.fn(() => ({ remove: jest.fn() })),
}));

/** Minimal controllable fake of the Supabase auth client. */
function makeFakeClient(initialSession: Session | null) {
  let listener: ((event: string, session: Session | null) => void) | null = null;
  let resolveGetSession: (value: { data: { session: Session | null }; error: null }) => void;
  const getSessionResult = new Promise<{ data: { session: Session | null }; error: null }>(
    (resolve) => {
      resolveGetSession = resolve;
    }
  );
  const client = {
    auth: {
      getSession: jest.fn(() => getSessionResult),
      onAuthStateChange: jest.fn((cb: (event: string, session: Session | null) => void) => {
        listener = cb;
        return { data: { subscription: { unsubscribe: jest.fn() } } };
      }),
      signInWithPassword: jest.fn().mockResolvedValue({ data: {}, error: null }),
      signUp: jest.fn().mockResolvedValue({ data: {}, error: null }),
      signOut: jest.fn().mockResolvedValue({ error: null }),
      resetPasswordForEmail: jest.fn().mockResolvedValue({ data: {}, error: null }),
      updateUser: jest.fn().mockResolvedValue({ data: {}, error: null }),
    },
  } as unknown as SupabaseClient;
  return {
    client,
    emit: (event: string, session: Session | null) => listener?.(event, session),
    finishRestore: () => resolveGetSession({ data: { session: initialSession }, error: null }),
  };
}

const fakeSession = {
  user: { id: 'user-1', email: 'student@example.com' },
} as unknown as Session;

function Probe() {
  const { status, user } = useAuth();
  return <Text testID="probe">{`${status}:${user?.email ?? 'none'}`}</Text>;
}

const probeText = () => screen.getByTestId('probe').props.children;

describe('AuthProvider', () => {
  it('restores a persisted session on startup (stays signed in across restarts)', async () => {
    const fake = makeFakeClient(fakeSession);
    await render(
      <AuthProvider client={fake.client}>
        <Probe />
      </AuthProvider>
    );
    // Loading state until restoration completes — no premature decisions.
    expect(probeText()).toBe('restoring:none');
    await act(async () => fake.finishRestore());
    await waitFor(() => expect(probeText()).toBe('signed-in:student@example.com'));
    expect(fake.client.auth.getSession).toHaveBeenCalled();
  });

  it('resolves to signed-out when no session is persisted', async () => {
    const fake = makeFakeClient(null);
    await render(
      <AuthProvider client={fake.client}>
        <Probe />
      </AuthProvider>
    );
    expect(probeText()).toBe('restoring:none');
    await act(async () => fake.finishRestore());
    await waitFor(() => expect(probeText()).toBe('signed-out:none'));
  });

  it('reports unavailable when Supabase is not configured', async () => {
    await render(
      <AuthProvider client={null}>
        <Probe />
      </AuthProvider>
    );
    expect(probeText()).toBe('unavailable:none');
  });

  it('follows auth-state listener events (sign-in then sign-out)', async () => {
    const fake = makeFakeClient(null);
    await render(
      <AuthProvider client={fake.client}>
        <Probe />
      </AuthProvider>
    );
    await act(async () => fake.finishRestore());
    await waitFor(() => expect(probeText()).toBe('signed-out:none'));

    await act(async () => fake.emit('SIGNED_IN', fakeSession));
    await waitFor(() => expect(probeText()).toBe('signed-in:student@example.com'));

    await act(async () => fake.emit('SIGNED_OUT', null));
    await waitFor(() => expect(probeText()).toBe('signed-out:none'));
  });

  it('signOut calls the provider and transitions to signed-out', async () => {
    const fake = makeFakeClient(fakeSession);
    let ctx: ReturnType<typeof useAuth> | null = null;
    function Grab() {
      ctx = useAuth();
      return null;
    }
    await render(
      <AuthProvider client={fake.client}>
        <Grab />
        <Probe />
      </AuthProvider>
    );
    await act(async () => fake.finishRestore());
    await waitFor(() => expect(probeText()).toBe('signed-in:student@example.com'));

    await act(async () => {
      const failure = await ctx!.signOut();
      expect(failure).toBeNull();
    });
    expect(fake.client.auth.signOut).toHaveBeenCalled();
    await waitFor(() => expect(probeText()).toBe('signed-out:none'));
  });

  it('returns user-safe errors from failed sign-in, never raw provider errors', async () => {
    const fake = makeFakeClient(null);
    (fake.client.auth.signInWithPassword as jest.Mock).mockResolvedValue({
      data: {},
      error: { message: 'Invalid login credentials', status: 400 },
    });
    let ctx: ReturnType<typeof useAuth> | null = null;
    function Grab() {
      ctx = useAuth();
      return null;
    }
    await render(
      <AuthProvider client={fake.client}>
        <Grab />
      </AuthProvider>
    );
    const failure = await ctx!.signIn('a@b.com', 'wrong');
    expect(failure?.kind).toBe('invalid-credentials');
    expect(failure?.message).not.toMatch(/invalid login credentials/i);
  });

  it('sign-up/sign-in report backend-unavailable when unconfigured', async () => {
    let ctx: ReturnType<typeof useAuth> | null = null;
    function Grab() {
      ctx = useAuth();
      return null;
    }
    await render(
      <AuthProvider client={null}>
        <Grab />
      </AuthProvider>
    );
    expect((await ctx!.signIn('a@b.com', 'pw'))?.kind).toBe('backend-unavailable');
    expect((await ctx!.signUp('a@b.com', 'pw'))?.kind).toBe('backend-unavailable');
  });

  it('treats a PASSWORD_RECOVERY event as recovery status, not signed-in', async () => {
    const fake = makeFakeClient(null);
    await render(
      <AuthProvider client={fake.client}>
        <Probe />
      </AuthProvider>
    );
    await act(async () => fake.finishRestore());
    await waitFor(() => expect(probeText()).toBe('signed-out:none'));

    await act(async () => fake.emit('PASSWORD_RECOVERY', fakeSession));
    await waitFor(() => expect(probeText()).toBe('recovery:student@example.com'));
  });

  it('requestPasswordReset calls resetPasswordForEmail and reports success', async () => {
    const fake = makeFakeClient(null);
    let ctx: ReturnType<typeof useAuth> | null = null;
    function Grab() {
      ctx = useAuth();
      return null;
    }
    await render(
      <AuthProvider client={fake.client}>
        <Grab />
      </AuthProvider>
    );
    const failure = await ctx!.requestPasswordReset('student@example.com');
    expect(failure).toBeNull();
    expect(fake.client.auth.resetPasswordForEmail).toHaveBeenCalledWith(
      'student@example.com',
      expect.objectContaining({ redirectTo: expect.any(String) })
    );
  });

  it('requestPasswordReset returns a user-safe error on failure', async () => {
    const fake = makeFakeClient(null);
    (fake.client.auth.resetPasswordForEmail as jest.Mock).mockResolvedValue({
      data: {},
      error: { message: 'Internal error', status: 503 },
    });
    let ctx: ReturnType<typeof useAuth> | null = null;
    function Grab() {
      ctx = useAuth();
      return null;
    }
    await render(
      <AuthProvider client={fake.client}>
        <Grab />
      </AuthProvider>
    );
    const failure = await ctx!.requestPasswordReset('student@example.com');
    expect(failure?.kind).toBe('backend-unavailable');
  });

  it('requestPasswordReset reports backend-unavailable when unconfigured', async () => {
    let ctx: ReturnType<typeof useAuth> | null = null;
    function Grab() {
      ctx = useAuth();
      return null;
    }
    await render(
      <AuthProvider client={null}>
        <Grab />
      </AuthProvider>
    );
    expect((await ctx!.requestPasswordReset('a@b.com'))?.kind).toBe('backend-unavailable');
  });

  it('updatePassword calls updateUser and promotes recovery to signed-in', async () => {
    const fake = makeFakeClient(null);
    let ctx: ReturnType<typeof useAuth> | null = null;
    function Grab() {
      ctx = useAuth();
      return null;
    }
    await render(
      <AuthProvider client={fake.client}>
        <Grab />
        <Probe />
      </AuthProvider>
    );
    await act(async () => fake.finishRestore());
    await act(async () => fake.emit('PASSWORD_RECOVERY', fakeSession));
    await waitFor(() => expect(probeText()).toBe('recovery:student@example.com'));

    await act(async () => {
      const failure = await ctx!.updatePassword('a-new-strong-password');
      expect(failure).toBeNull();
    });
    expect(fake.client.auth.updateUser).toHaveBeenCalledWith({
      password: 'a-new-strong-password',
    });
    await waitFor(() => expect(probeText()).toBe('signed-in:student@example.com'));
  });

  it('updatePassword returns a user-safe error and leaves status unchanged on failure', async () => {
    const fake = makeFakeClient(null);
    (fake.client.auth.updateUser as jest.Mock).mockResolvedValue({
      data: {},
      error: { message: 'Password should be at least 6 characters' },
    });
    let ctx: ReturnType<typeof useAuth> | null = null;
    function Grab() {
      ctx = useAuth();
      return null;
    }
    await render(
      <AuthProvider client={fake.client}>
        <Grab />
        <Probe />
      </AuthProvider>
    );
    await act(async () => fake.finishRestore());
    await act(async () => fake.emit('PASSWORD_RECOVERY', fakeSession));
    await waitFor(() => expect(probeText()).toBe('recovery:student@example.com'));

    const failure = await ctx!.updatePassword('weak');
    expect(failure?.kind).toBe('weak-password');
    await waitFor(() => expect(probeText()).toBe('recovery:student@example.com'));
  });

  it('updatePassword reports backend-unavailable when unconfigured', async () => {
    let ctx: ReturnType<typeof useAuth> | null = null;
    function Grab() {
      ctx = useAuth();
      return null;
    }
    await render(
      <AuthProvider client={null}>
        <Grab />
      </AuthProvider>
    );
    expect((await ctx!.updatePassword('new-password'))?.kind).toBe('backend-unavailable');
  });
});
