import { mapAuthError, authErrorFor } from './errors';

describe('mapAuthError — user-safe authentication errors', () => {
  it('maps invalid credentials', () => {
    expect(mapAuthError({ message: 'Invalid login credentials', status: 400 }).kind).toBe(
      'invalid-credentials'
    );
    expect(mapAuthError({ code: 'invalid_credentials', message: 'x' }).kind).toBe(
      'invalid-credentials'
    );
  });

  it('maps duplicate accounts', () => {
    expect(mapAuthError({ code: 'user_already_exists', message: 'x' }).kind).toBe(
      'duplicate-account'
    );
    expect(mapAuthError({ message: 'User already registered' }).kind).toBe('duplicate-account');
  });

  it('maps weak passwords and invalid emails', () => {
    expect(mapAuthError({ message: 'Password should be at least 6 characters' }).kind).toBe(
      'weak-password'
    );
    expect(mapAuthError({ code: 'validation_failed', message: 'invalid format' }).kind).toBe(
      'invalid-email'
    );
  });

  it('maps expired/invalid sessions', () => {
    expect(mapAuthError({ code: 'refresh_token_not_found', message: 'x' }).kind).toBe(
      'expired-session'
    );
    expect(mapAuthError({ message: 'JWT expired' }).kind).toBe('expired-session');
  });

  it('maps network failures', () => {
    expect(mapAuthError(new TypeError('Failed to fetch')).kind).toBe('network');
    expect(mapAuthError({ name: 'AuthRetryableFetchError', message: 'x' }).kind).toBe('network');
  });

  it('maps server outages to backend-unavailable', () => {
    expect(mapAuthError({ message: 'Internal error', status: 503 }).kind).toBe(
      'backend-unavailable'
    );
  });

  it('never exposes the raw provider message', () => {
    const raw = { message: 'pq: duplicate key value violates unique constraint "users_pkey"' };
    const safe = mapAuthError(raw);
    expect(safe.message).not.toContain('pq:');
    expect(safe.message).not.toContain('constraint');
  });

  it('falls back to a generic message for unknown errors', () => {
    expect(mapAuthError(undefined).kind).toBe('unknown');
    expect(mapAuthError({ message: 'weird' }).kind).toBe('unknown');
    expect(authErrorFor('unknown').message.length).toBeGreaterThan(0);
  });
});
