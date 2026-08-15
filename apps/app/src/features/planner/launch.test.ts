import { PLAN_ACTIVITY_TYPES, PLAN_REASON_CODES } from '@avidia/planner';

import {
  ACTIVITY_TYPE_LABELS,
  PLAN_REASON_LABELS,
  activityLaunchRoute,
  reasonLine,
} from './launch';
import { safeDeepLink } from './notifications';

/**
 * Planner presentation helper tests — M13 (spec M/O/AG).
 *
 * Labels must cover every plannable type/reason, reason copy must be plain
 * and countdown-aware, launch routes must point at EXISTING experiences only,
 * and notification deep links must be allowlist-validated.
 */

describe('ACTIVITY_TYPE_LABELS (spec M)', () => {
  it('covers every plannable activity type with a student-facing label', () => {
    for (const type of PLAN_ACTIVITY_TYPES) {
      expect(ACTIVITY_TYPE_LABELS[type]).toBeTruthy();
    }
  });
});

describe('PLAN_REASON_LABELS (spec O)', () => {
  it('covers every deterministic reason code', () => {
    for (const code of PLAN_REASON_CODES) {
      expect(PLAN_REASON_LABELS[code]).toBeTruthy();
    }
  });

  it('never uses judgmental wording', () => {
    for (const label of Object.values(PLAN_REASON_LABELS)) {
      expect(label.toLowerCase()).not.toMatch(/fail|behind|bad|weakness/);
    }
  });
});

describe('reasonLine (spec O/X)', () => {
  it('renders exam countdowns for today, tomorrow, and N days', () => {
    expect(reasonLine([{ code: 'exam_soon', examId: 'e', daysUntilExam: 0 }])).toBe('Exam today');
    expect(reasonLine([{ code: 'exam_soon', examId: 'e', daysUntilExam: 1 }])).toBe(
      'Exam tomorrow'
    );
    expect(reasonLine([{ code: 'exam_soon', examId: 'e', daysUntilExam: 7 }])).toBe(
      'Exam in 7 days'
    );
  });

  it('falls back to the plain label for other codes and empty for none', () => {
    expect(reasonLine([{ code: 'review_due' }])).toBe('Review due');
    expect(reasonLine([{ code: 'coverage_gap' }])).toBe('Not assessed yet');
    expect(reasonLine([])).toBe('');
  });
});

describe('activityLaunchRoute (spec M/Y)', () => {
  it('routes adaptive-style activities to the M9 adaptive session with minutes', () => {
    for (const type of ['start_today', 'due_review', 'targeted_practice'] as const) {
      expect(activityLaunchRoute({ courseId: 'c1', type, modeId: null, minutes: 20 })).toBe(
        '/course/c1/practice?mode=adaptive&minutes=20'
      );
    }
  });

  it('routes priority challenge to its M10 mode with a safe fallback', () => {
    expect(
      activityLaunchRoute({
        courseId: 'c1',
        type: 'priority_challenge',
        modeId: 'who_first',
        minutes: 10,
      })
    ).toBe('/course/c1/practice?mode=who_first');
    expect(
      activityLaunchRoute({ courseId: 'c1', type: 'priority_challenge', modeId: null, minutes: 10 })
    ).toBe('/course/c1/practice?mode=who_first');
  });

  it('routes simulation to the M11 simulation screen', () => {
    expect(
      activityLaunchRoute({ courseId: 'c1', type: 'simulation', modeId: null, minutes: 20 })
    ).toBe('/course/c1/simulation');
  });

  it('routes other modes by their activity type', () => {
    expect(
      activityLaunchRoute({ courseId: 'c1', type: 'rapid_response', modeId: null, minutes: 10 })
    ).toBe('/course/c1/practice?mode=rapid_response');
    expect(
      activityLaunchRoute({ courseId: 'c1', type: 'boss_battle', modeId: null, minutes: 15 })
    ).toBe('/course/c1/practice?mode=boss_battle');
  });
});

describe('safeDeepLink (spec AG)', () => {
  it('allows only known in-app destinations', () => {
    expect(safeDeepLink('/planner')).toBe('/planner');
    expect(safeDeepLink('/home')).toBe('/home');
    expect(safeDeepLink('/study')).toBe('/study');
  });

  it('rejects external, unknown, or missing urls', () => {
    expect(safeDeepLink('https://evil.example/phish')).toBe('/home');
    expect(safeDeepLink('/admin')).toBe('/home');
    expect(safeDeepLink(null)).toBe('/home');
    expect(safeDeepLink(undefined)).toBe('/home');
    expect(safeDeepLink(42)).toBe('/home');
  });
});
