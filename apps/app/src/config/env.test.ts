import { env } from './env';

describe('app environment configuration', () => {
  it('loads and validates without throwing, with a usable default environment', () => {
    expect(['development', 'preview', 'production']).toContain(env.EXPO_PUBLIC_APP_ENV);
  });
});
