import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { localDateKey } from '@avidia/planner';

import { PlannerScreen } from './PlannerScreen';
import type { StoredPlan } from '../plannerApi';

/**
 * Planner screen tests — M13 (spec V/W/X/P/AR/AQ).
 *
 * The screen renders STORED plan rows and forwards taps to existing
 * experiences; these tests cover the gentle empty states, the Today view with
 * START TODAY'S PLAN, skip, the honest over-capacity constraint, and the exam
 * countdown — all without any AI dependency (spec AQ).
 */

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual('react');
  return {
    router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
    useFocusEffect: (cb: () => void) => {
      useEffect(() => {
        cb();
      }, [cb]);
    },
  };
});

import { router } from 'expo-router';
const mockRouter = router as unknown as { push: jest.Mock };

jest.mock('../../auth/AuthProvider', () => {
  const user = { id: 'user-1', email: 'student@example.com' };
  return { useAuth: () => ({ user }) };
});
jest.mock('../../../lib/supabase', () => ({ getSupabase: () => ({ mocked: true }) }));
jest.mock('../../profile/useTimezone', () => ({ useUserTimezone: () => 'America/Chicago' }));
jest.mock('../../courses/coursesApi', () => ({ listOwnCourses: jest.fn() }));
// Mock only the fetch/persist seams; keep pure helpers real.
jest.mock('../plannerApi', () => ({
  ...jest.requireActual('../plannerApi'),
  fetchPlannerSettings: jest.fn(),
  fetchActivePlan: jest.fn(),
  reconcilePlanCompletion: jest.fn(),
  countSimulationCases: jest.fn(),
  loadPlannerCourseInput: jest.fn(),
  saveStudyPlan: jest.fn(),
  startPlannedActivity: jest.fn(),
  skipPlannedActivity: jest.fn(),
}));
jest.mock('../notifications', () => ({
  ...jest.requireActual('../notifications'),
  remindersSupported: () => false,
  syncScheduledReminders: jest.fn(),
}));

import * as coursesApi from '../../courses/coursesApi';
import * as plannerApi from '../plannerApi';

const mocked = <T,>(fn: T) => fn as jest.Mock;

const course = {
  id: 'course-1',
  user_id: 'user-1',
  title: 'Adult Health I',
  term: 'Fall 2026',
  institution_name: null,
  status: 'active',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  module_count: 2,
  exams: [{ id: 'exam-1', title: 'Exam 1', exam_at: '2099-09-01T14:00:00.000Z' }],
};

const settings = {
  availability: { preset: 'standard' as const, minutesByWeekday: [45, 45, 45, 45, 45, 45, 45] },
  reminders: {
    studyReminders: false,
    reviewReminders: false,
    examReminders: false,
    reminderHour: 18,
    quietStartHour: 22,
    quietEndHour: 7,
  },
};

const todayKey = localDateKey(new Date(), 'America/Chicago');

function storedPlan(overrides?: {
  overCapacity?: boolean;
  activityStatus?: 'planned' | 'started' | 'completed' | 'skipped';
}): StoredPlan {
  return {
    plan: {
      id: 'plan-1',
      revision: 1,
      horizon_start: todayKey,
      horizon_end: todayKey,
      time_zone: 'America/Chicago',
      total_planned_minutes: 15,
      total_need_minutes: 15,
      capacity_minutes: 45,
      over_capacity: overrides?.overCapacity ?? false,
      created_at: new Date().toISOString(),
    },
    activities: [
      {
        id: 'activity-1',
        course_id: 'course-1',
        activity_date: todayKey,
        position: 0,
        activity_type: 'due_review',
        concept_id: 'concept-1',
        mode_id: null,
        minutes: 15,
        reasons: [{ code: 'review_due' }],
        status: overrides?.activityStatus ?? 'planned',
        session_id: null,
        simulation_session_id: null,
      },
    ],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mocked(coursesApi.listOwnCourses).mockResolvedValue([course]);
  mocked(plannerApi.fetchPlannerSettings).mockResolvedValue(settings);
  mocked(plannerApi.fetchActivePlan).mockResolvedValue(null);
  mocked(plannerApi.reconcilePlanCompletion).mockResolvedValue(0);
  mocked(plannerApi.countSimulationCases).mockResolvedValue(0);
  mocked(plannerApi.startPlannedActivity).mockResolvedValue(undefined);
  mocked(plannerApi.skipPlannedActivity).mockResolvedValue(undefined);
});

describe('PlannerScreen empty states (spec AR/AS)', () => {
  it('guides course creation when no courses exist', async () => {
    mocked(coursesApi.listOwnCourses).mockResolvedValue([]);
    await render(<PlannerScreen />);
    expect(await screen.findByText('Your plan starts with a course.')).toBeTruthy();
  });

  it('offers to build a plan when none exists yet', async () => {
    await render(<PlannerScreen />);
    expect(await screen.findByText('No plan yet')).toBeTruthy();
    expect(screen.getByText('Build my plan')).toBeTruthy();
  });

  it('prompts availability setup when every day is zero minutes', async () => {
    mocked(plannerApi.fetchPlannerSettings).mockResolvedValue({
      ...settings,
      availability: { preset: 'custom' as const, minutesByWeekday: [0, 0, 0, 0, 0, 0, 0] },
    });
    await render(<PlannerScreen />);
    expect(await screen.findByText('No study time set')).toBeTruthy();
  });
});

describe('PlannerScreen today view (spec V/X/Y)', () => {
  it('renders the stored plan with countdown, activity label, and reason', async () => {
    mocked(plannerApi.fetchActivePlan).mockResolvedValue(storedPlan());
    await render(<PlannerScreen />);
    expect(await screen.findByText('Today')).toBeTruthy();
    expect(screen.getByText('Review session')).toBeTruthy();
    expect(screen.getByText(/Adult Health I · 15 min · Review due/)).toBeTruthy();
    // Exam countdown badge in student timezone (2099 exam → far-future days).
    expect(screen.getByText(/Exam 1 · Adult Health I/)).toBeTruthy();
    expect(screen.getByText(/Exam in \d+ days/)).toBeTruthy();
  });

  it("START TODAY'S PLAN starts the first pending activity and launches it", async () => {
    mocked(plannerApi.fetchActivePlan).mockResolvedValue(storedPlan());
    await render(<PlannerScreen />);
    fireEvent.press(await screen.findByText("START TODAY'S PLAN"));
    await screen.findByText('Today');
    expect(mocked(plannerApi.startPlannedActivity)).toHaveBeenCalledWith(
      expect.anything(),
      'activity-1'
    );
    expect(mockRouter.push).toHaveBeenCalledWith(
      '/course/course-1/practice?mode=adaptive&minutes=15'
    );
  });

  it('skip marks the activity skipped without launching anything', async () => {
    mocked(plannerApi.fetchActivePlan).mockResolvedValue(storedPlan());
    await render(<PlannerScreen />);
    const skipButton = await screen.findByLabelText('Skip Review session');
    await act(async () => {
      fireEvent.press(skipButton);
    });
    expect(await screen.findByText(/skipped/)).toBeTruthy();
    expect(mocked(plannerApi.skipPlannedActivity)).toHaveBeenCalledWith(
      expect.anything(),
      'activity-1'
    );
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('celebrates a fully completed day instead of showing the CTA', async () => {
    mocked(plannerApi.fetchActivePlan).mockResolvedValue(
      storedPlan({ activityStatus: 'completed' })
    );
    await render(<PlannerScreen />);
    expect(await screen.findByText(/plan is done/)).toBeTruthy();
    expect(screen.queryByText("START TODAY'S PLAN")).toBeNull();
  });
});

describe('PlannerScreen honest capacity (spec P)', () => {
  it('shows the constraint when need exceeds available time', async () => {
    mocked(plannerApi.fetchActivePlan).mockResolvedValue(storedPlan({ overCapacity: true }));
    await render(<PlannerScreen />);
    expect(await screen.findByText(/more recommended work than your available time/)).toBeTruthy();
  });
});
