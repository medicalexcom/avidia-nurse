/**
 * Privacy-conscious analytics events — M9 (spec Z).
 *
 * A typed, in-process event emitter with NO network transport in v1: events
 * are buffered in memory (capped) so tests and future transports can observe
 * them, and logged in dev builds. Privacy is enforced by CONSTRUCTION, not
 * convention — the payload types below physically cannot carry course text,
 * question stems, answers, mastery numbers, or any other private content.
 * Only event names, durations, and counts exist.
 */

export type AnalyticsEvent =
  | { name: 'daily_session_started'; requestedMinutes: number; plannedQuestions: number }
  | { name: 'daily_session_completed'; answeredCount: number; skippedCount: number }
  | { name: 'daily_session_abandoned'; answeredCount: number }
  | { name: 'quick_session_started'; requestedMinutes: number }
  | {
      name: 'mode_session_started';
      mode: 'rapid_response' | 'find_the_danger' | 'who_first' | 'medication_lab' | 'boss_battle';
    }
  | { name: 'source_viewed' }
  | { name: 'explain_more_used' }
  // M11 simulation telemetry (spec BE): ONLY these four events exist. No
  // per-action tracking, no free text, no scores — case keys are library
  // identifiers and outcome kinds are the closed enum from the case format,
  // so nothing personal can be serialized here either.
  | { name: 'simulation_started'; caseKey: string; resumed: boolean }
  | { name: 'simulation_completed'; caseKey: string; outcomeKind: string; durationMinutes: number }
  | { name: 'simulation_abandoned'; caseKey: string }
  | { name: 'hint_used'; caseKey: string }
  // M12 (spec AM): the ONLY analytics-page event, and it is payload-free by
  // construction — no metric, mastery number, readiness state or course
  // content can ride along to any transport.
  | { name: 'analytics_viewed' }
  // M14 billing funnel (spec AG): payload-free by construction — no prices,
  // no provider identifiers, no personal data can ride along. The funnel is
  // observable (viewed → started → outcome) without knowing anything about
  // the student.
  | { name: 'paywall_viewed' }
  | { name: 'checkout_started' }
  | { name: 'billing_portal_opened' }
  | { name: 'restore_purchases_attempted' }
  | { name: 'data_export_requested' }
  | { name: 'account_deletion_requested' };

const MAX_BUFFERED_EVENTS = 200;
const buffer: AnalyticsEvent[] = [];

/** Record an analytics event (in-memory only in v1 — no network). */
export function trackEvent(event: AnalyticsEvent): void {
  buffer.push(event);
  if (buffer.length > MAX_BUFFERED_EVENTS) buffer.shift();
  if (__DEV__) {
    console.debug('[analytics]', event.name, event);
  }
}

/** The buffered events (read-only view) — used by tests and future flushers. */
export function bufferedEvents(): readonly AnalyticsEvent[] {
  return buffer;
}

/** Clear the buffer (tests). */
export function resetAnalytics(): void {
  buffer.length = 0;
}
