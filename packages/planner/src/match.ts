/**
 * Session → planned-activity reconciliation — M13 (spec U/Y/Z/AN).
 *
 * An activity is completed by ACTUAL completion evidence — a completed M9/M10
 * study session or a completed M11 simulation — never by "the screen was
 * opened" (spec U). The matcher is pure and deterministic: sessions are
 * consumed in completion order, each satisfying at most ONE compatible
 * pending activity in plan order; the database's unique session binding
 * makes the assignment idempotent under retries (spec AN).
 *
 * Partial work is never discarded (spec Z): attempts and mastery updates
 * were already persisted by the underlying engines — an unmatched or
 * unfinished session simply leaves the activity pending, and the next
 * recalculation sees the updated mastery anyway (spec T).
 */

import type { PlanActivityType } from './types';

export interface MatchableActivity {
  activityId: string;
  courseId: string;
  type: PlanActivityType;
  /** Already-bound session, so re-runs skip it. */
  boundSessionId: string | null;
}

export interface CompletedSessionLike {
  sessionId: string;
  courseId: string;
  /** study_sessions.session_type, or 'simulation' for M11 sessions. */
  sessionType: string;
  completedAt: string;
}

/** Which session types can satisfy which planned activity type. */
export function sessionSatisfies(activityType: PlanActivityType, sessionType: string): boolean {
  switch (activityType) {
    case 'start_today':
    case 'due_review':
    case 'targeted_practice':
      return sessionType === 'adaptive' || sessionType === 'practice';
    case 'rapid_response':
      return sessionType === 'rapid_response';
    case 'medication_lab':
      return sessionType === 'medication_lab';
    case 'priority_challenge':
      return sessionType === 'who_first';
    case 'find_the_danger':
      return sessionType === 'find_the_danger';
    case 'boss_battle':
      return sessionType === 'boss_battle';
    case 'simulation':
      return sessionType === 'simulation';
  }
}

export interface MatchAssignment {
  activityId: string;
  sessionId: string;
}

/**
 * Greedy earliest-session → earliest-compatible-activity matching.
 * `activities` must be in plan order (date, position); already-bound
 * activities and already-bound sessions are excluded up front.
 */
export function matchSessionsToActivities(
  activities: readonly MatchableActivity[],
  sessions: readonly CompletedSessionLike[]
): MatchAssignment[] {
  const boundSessions = new Set(
    activities.map((a) => a.boundSessionId).filter((id): id is string => id !== null)
  );
  const pending = activities.filter((a) => a.boundSessionId === null);
  const ordered = [...sessions]
    .filter((s) => !boundSessions.has(s.sessionId))
    .sort(
      (a, b) => a.completedAt.localeCompare(b.completedAt) || a.sessionId.localeCompare(b.sessionId)
    );

  const assignments: MatchAssignment[] = [];
  const taken = new Set<string>();
  for (const session of ordered) {
    const target = pending.find(
      (a) =>
        !taken.has(a.activityId) &&
        a.courseId === session.courseId &&
        sessionSatisfies(a.type, session.sessionType)
    );
    if (!target) continue;
    taken.add(target.activityId);
    assignments.push({ activityId: target.activityId, sessionId: session.sessionId });
  }
  return assignments;
}
