import { bufferedEvents, resetAnalytics, trackEvent } from './analytics';

/**
 * Analytics events — M9 (spec Z). Privacy is enforced by the payload types
 * (no content fields exist); these tests cover the buffer mechanics.
 */

beforeEach(() => {
  resetAnalytics();
});

describe('analytics buffer', () => {
  it('records events in order', () => {
    trackEvent({ name: 'quick_session_started', requestedMinutes: 5 });
    trackEvent({ name: 'source_viewed' });
    expect(bufferedEvents()).toEqual([
      { name: 'quick_session_started', requestedMinutes: 5 },
      { name: 'source_viewed' },
    ]);
  });

  it('caps the buffer so memory cannot grow without bound', () => {
    for (let index = 0; index < 250; index += 1) {
      trackEvent({ name: 'explain_more_used' });
    }
    expect(bufferedEvents().length).toBe(200);
  });

  it('resets cleanly for tests', () => {
    trackEvent({ name: 'source_viewed' });
    resetAnalytics();
    expect(bufferedEvents()).toEqual([]);
  });
});
