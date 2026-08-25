import { buildRecoveryRedirectUrl, isPasswordRecoveryUrl } from './recoveryLink';

describe('isPasswordRecoveryUrl', () => {
  it('detects type=recovery as a query param', () => {
    expect(isPasswordRecoveryUrl('https://example.com/reset-password?type=recovery')).toBe(true);
    expect(isPasswordRecoveryUrl('https://example.com/reset-password?code=abc&type=recovery')).toBe(
      true
    );
  });

  it('detects type=recovery inside a URL fragment (implicit flow)', () => {
    expect(
      isPasswordRecoveryUrl(
        'https://example.com/reset-password#access_token=xyz&expires_in=3600&type=recovery'
      )
    ).toBe(true);
  });

  it('detects type=recovery in a custom-scheme native deep link', () => {
    expect(isPasswordRecoveryUrl('avidianurse:///reset-password?code=abc&type=recovery')).toBe(
      true
    );
  });

  it('does not match a plain sign-in callback or other type values', () => {
    expect(isPasswordRecoveryUrl('https://example.com/reset-password')).toBe(false);
    expect(isPasswordRecoveryUrl('https://example.com/?type=signup')).toBe(false);
    expect(isPasswordRecoveryUrl('https://example.com/?type=recoveryfoo')).toBe(false);
  });

  it('handles null/undefined/empty input', () => {
    expect(isPasswordRecoveryUrl(null)).toBe(false);
    expect(isPasswordRecoveryUrl(undefined)).toBe(false);
    expect(isPasswordRecoveryUrl('')).toBe(false);
  });
});

describe('buildRecoveryRedirectUrl', () => {
  const createNativeUrl = () => 'avidianurse:///reset-password';

  it('prefers EXPO_PUBLIC_WEB_APP_URL on web, stripping a trailing slash', () => {
    expect(
      buildRecoveryRedirectUrl({
        platform: 'web',
        webAppUrl: 'https://medicalexcom.github.io/avidia-nurse/',
        windowOrigin: 'https://medicalexcom.github.io',
        createNativeUrl,
      })
    ).toBe('https://medicalexcom.github.io/avidia-nurse/reset-password');
  });

  it('falls back to window.location.origin on web when unconfigured', () => {
    expect(
      buildRecoveryRedirectUrl({
        platform: 'web',
        windowOrigin: 'http://localhost:8081',
        createNativeUrl,
      })
    ).toBe('http://localhost:8081/reset-password');
  });

  it('falls back to a relative path when neither is available', () => {
    expect(buildRecoveryRedirectUrl({ platform: 'web', createNativeUrl })).toBe('/reset-password');
  });

  it('uses the native deep link on non-web platforms, ignoring web-only options', () => {
    expect(
      buildRecoveryRedirectUrl({
        platform: 'ios',
        webAppUrl: 'https://medicalexcom.github.io/avidia-nurse',
        createNativeUrl,
      })
    ).toBe('avidianurse:///reset-password');
    expect(buildRecoveryRedirectUrl({ platform: 'android', createNativeUrl })).toBe(
      'avidianurse:///reset-password'
    );
  });
});
