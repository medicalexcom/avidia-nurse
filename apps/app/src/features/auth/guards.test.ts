import { decideRoute, routeGroupFromSegments } from './guards';

describe('routeGroupFromSegments', () => {
  it('classifies expo-router segments', () => {
    expect(routeGroupFromSegments(['(auth)', 'sign-in'])).toBe('auth');
    expect(routeGroupFromSegments(['(app)', 'profile'])).toBe('app');
    expect(routeGroupFromSegments([])).toBe('other');
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
});
