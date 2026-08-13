import { EnvValidationError, validateClientEnv } from './env';

describe('validateClientEnv', () => {
  it('applies safe defaults when no variables are provided', () => {
    const env = validateClientEnv({});
    expect(env.EXPO_PUBLIC_APP_ENV).toBe('development');
    expect(env.EXPO_PUBLIC_API_URL).toBeUndefined();
  });

  it('accepts a valid configuration', () => {
    const env = validateClientEnv({
      EXPO_PUBLIC_APP_ENV: 'production',
      EXPO_PUBLIC_API_URL: 'https://api.avidianurse.example.com',
    });
    expect(env.EXPO_PUBLIC_APP_ENV).toBe('production');
    expect(env.EXPO_PUBLIC_API_URL).toBe('https://api.avidianurse.example.com');
  });

  it('rejects an unknown app environment', () => {
    expect(() => validateClientEnv({ EXPO_PUBLIC_APP_ENV: 'staging' })).toThrow(EnvValidationError);
  });

  it('rejects a malformed API URL', () => {
    expect(() => validateClientEnv({ EXPO_PUBLIC_API_URL: 'not-a-url' })).toThrow(
      EnvValidationError
    );
  });

  it('rejects non-http(s) protocols', () => {
    expect(() =>
      validateClientEnv({ EXPO_PUBLIC_API_URL: 'ftp://api.avidianurse.example.com' })
    ).toThrow(EnvValidationError);
  });

  it('produces a readable error message listing each issue', () => {
    try {
      validateClientEnv({ EXPO_PUBLIC_APP_ENV: 'bogus', EXPO_PUBLIC_API_URL: 'nope' });
      fail('expected EnvValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as EnvValidationError).message;
      expect(message).toContain('EXPO_PUBLIC_APP_ENV');
      expect(message).toContain('EXPO_PUBLIC_API_URL');
    }
  });
});
