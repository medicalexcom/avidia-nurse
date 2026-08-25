import { decideRoute, routeGroupFromSegments } from './guards';

describe('routeGroupFromSegments', () => {
  it('classifies expo-router segments', () => {
    expect(routeGroupFromSegments(['(auth)', 'sign-in'])).toBe('auth');
    expect(routeGroupFromSegments(['(auth)', 'forgot-password'])).toBe('auth');
    expect(routeGroupFromSegments(['(app)', 'profile'])).toBe('app');
    expect(routeGroupFromSegments([])).toBe('other');
  });

  it('classifies the reset-password screen distinctly from the rest of (auth)', () => {
    expect(routeGroupFromSegments(['(auth)', 'reset-password'])).toBe('reset-password');
  });
});

describe('decideRoute — protected navigation', () => {
  it('shows a loading state while the persisted session is restoring', () => {
    expect(decideRoute('restoring', 'app')).toEqual({ action: 'show-loading' });
    expect(decideRoute('restoring', 'auth')).toEqual({ action: 'show-loading' });
  });

  it('blocks unauthenticated users from every protected area', () => {
    expect(decideRoute('signed-out', 'app')).toEqual({ action: 'redirect', to: '/sign-in' });
    expect(decideRoute('signed-out', 'other')).toEqual({ action: 'redirect', to: '/sign-in' });
  });

  it('blocks protected areas when the backend is unavailable', () => {
    expect(decideRoute('unavailable', 'app')).toEqual({ action: 'redirect', to: '/sign-in' });
  });

  it('lets unauthenticated users use the auth screens', () => {
    expect(decideRoute('signed-out', 'auth')).toEqual({ action: 'stay' });
    expect(decideRoute('unavailable', 'auth')).toEqual({ action: 'stay' });
  });

  it('moves signed-in users out of the auth screens into the shell', () => {
    expect(decideRoute('signed-in', 'auth')).toEqual({ action: 'redirect', to: '/home' });
    expect(decideRoute('signed-in', 'other')).toEqual({ action: 'redirect', to: '/home' });
  });

  it('leaves signed-in users alone inside the shell', () => {
    expect(decideRoute('signed-in', 'app')).toEqual({ action: 'stay' });
  });

  it('funnels a recovery-status student to /reset-password from anywhere else', () => {
    expect(decideRoute('recovery', 'app')).toEqual({ action: 'redirect', to: '/reset-password' });
    expect(decideRoute('recovery', 'auth')).toEqual({
      action: 'redirect',
      to: '/reset-password',
    });
    expect(decideRoute('recovery', 'other')).toEqual({
      action: 'redirect',
      to: '/reset-password',
    });
  });

  it('leaves a recovery-status student alone on /reset-password', () => {
    expect(decideRoute('recovery', 'reset-password')).toEqual({ action: 'stay' });
  });

  it('keeps /reset-password reachable in every other status, for its own explanation of an invalid/expired link', () => {
    expect(decideRoute('signed-out', 'reset-password')).toEqual({ action: 'stay' });
    expect(decideRoute('unavailable', 'reset-password')).toEqual({ action: 'stay' });
    expect(decideRoute('signed-in', 'reset-password')).toEqual({ action: 'stay' });
  });
});
