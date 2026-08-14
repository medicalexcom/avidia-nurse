import { fireEvent, render, screen } from '@testing-library/react-native';

import type { AnalyticsInput, AttemptRecord } from '@avidia/analytics';

import { AnalyticsScreen } from './AnalyticsScreen';

/**
 * Analytics screen tests — M12 (spec D/H/AD/AI/R). The pure engine is NOT
 * mocked: fixtures flow through the real `getCourseAnalytics`, so these tests
 * also pin the UI to the engine's honest outputs (evidence-backed attention
 * reasons, no grade predictions, real empty state).
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
const mockRouter = router as unknown as { push: jest.Mock; replace: jest.Mock };

jest.mock('../../auth/AuthProvider', () => {
  const user = { id: 'user-1', email: 'student@example.com' };
  return { useAuth: () => ({ user }) };
});

jest.mock('../../../lib/supabase', () => ({
  getSupabase: () => ({ mocked: true }),
}));

jest.mock('../../profile/useTimezone', () => ({
  useUserTimezone: () => 'America/Chicago',
}));

jest.mock('../../courses/coursesApi', () => ({
  fetchOwnCourse: jest.fn(),
  listOwnCourses: jest.fn(),
}));
jest.mock('../analyticsApi', () => ({
  loadAnalyticsInput: jest.fn(),
}));

import * as coursesApi from '../../courses/coursesApi';
import * as analyticsApi from '../analyticsApi';

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
};

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function attemptAt(
  index: number,
  conceptId: string,
  isCorrect: boolean,
  ageDays: number
): AttemptRecord {
  return {
    attemptId: `a-${index}`,
    questionId: `q-${index}`,
    conceptId,
    isCorrect,
    confidence: null,
    difficulty: 'moderate',
    cognitiveLevel: 'application',
    questionType: 'sba',
    sessionType: 'adaptive',
    createdAt: new Date(Date.now() - ageDays * DAY - index * 60_000).toISOString(),
  };
}

/** c1 is weak with plenty of evidence; c2 is strong with plenty of evidence. */
function buildInput(): AnalyticsInput {
  const attempts: AttemptRecord[] = [
    ...Array.from({ length: 6 }, (_, i) => attemptAt(i, 'c1', i === 0, i % 3)),
    ...Array.from({ length: 6 }, (_, i) => attemptAt(10 + i, 'c2', true, i % 3)),
  ];
  const aggregate = {
    misconceptionSeverity: 0,
    reviewStage: 1,
    lastAttemptAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    nextReviewAt: new Date(Date.now() + 2 * DAY).toISOString(),
  };
  return {
    attempts,
    mastery: [
      {
        conceptId: 'c1',
        aggregate: { ...aggregate, mastery: 0.2, attemptsCount: 6, correctCount: 1 },
      },
      {
        conceptId: 'c2',
        aggregate: { ...aggregate, mastery: 0.9, attemptsCount: 6, correctCount: 6 },
      },
    ],
    concepts: [
      {
        conceptId: 'c1',
        canonicalName: 'Hyperkalemia management',
        conceptType: 'condition',
        emphasisScore: 8,
      },
      {
        conceptId: 'c2',
        canonicalName: 'Insulin administration',
        conceptType: 'medication',
        emphasisScore: 4,
      },
    ],
    sessions: [
      {
        sessionId: 's-1',
        sessionType: 'adaptive',
        status: 'completed',
        startedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
        completedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
        attemptCount: 12,
      },
    ],
    exams: [
      {
        examId: 'e1',
        title: 'Exam 2 — Endocrine',
        examAt: new Date(Date.now() + 10 * DAY).toISOString(),
      },
    ],
    simulations: [
      {
        sessionId: 'sim-1',
        caseKey: 'postop_pe',
        caseTitle: 'Post-op day 2: sudden dyspnea',
        outcomeKind: 'stabilized',
        outcomeLabel: 'Patient stabilized',
        completedAt: new Date(Date.now() - 1 * DAY).toISOString(),
        earned: 9,
        possible: 12,
        criticalMissedCount: 1,
        unsafeActionCount: 0,
        dimensions: [
          { dimension: 'recognize_cues', label: 'Recognize cues', earned: 3, possible: 4 },
        ],
      },
    ],
    timeZone: 'America/Chicago',
    now: new Date(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mocked(coursesApi.fetchOwnCourse).mockResolvedValue(course);
  mocked(analyticsApi.loadAnalyticsInput).mockResolvedValue(buildInput());
});

describe('AnalyticsScreen (spec D/H/AD)', () => {
  it('renders readiness with reasons and the no-grade disclaimer (spec N/R)', async () => {
    await render(<AnalyticsScreen courseId="course-1" />);
    await screen.findByText('Exam readiness');
    expect(screen.getByText(/Exam 2 — Endocrine/)).toBeTruthy();
    expect(screen.getByText(/Readiness describes your preparation, not your grade/)).toBeTruthy();
    // Limited evidence is said out loud (spec Q).
    expect(screen.getByText(/Based on limited evidence so far/)).toBeTruthy();
  });

  it('lists the weak concept under Needs attention with its evidence reason (spec H)', async () => {
    await render(<AnalyticsScreen courseId="course-1" />);
    await screen.findByText('Needs attention');
    expect(screen.getAllByText('Hyperkalemia management').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Recent answers suggest a gap/).length).toBeGreaterThan(0);
    // The strong, well-evidenced concept shows as a strength (spec I).
    expect(screen.getByText('✓ Insulin administration')).toBeTruthy();
  });

  it('insight CTA routes into the concept page (spec AD)', async () => {
    await render(<AnalyticsScreen courseId="course-1" />);
    await screen.findByText('What to do next');
    await fireEvent.press(screen.getByText('Review Hyperkalemia management'));
    expect(mockRouter.push).toHaveBeenCalledWith('/course/course-1/concept/c1');
  });

  it('shows simulation aggregates without hidden case internals (spec Z)', async () => {
    await render(<AnalyticsScreen courseId="course-1" />);
    await screen.findByText('Simulations');
    expect(screen.getByText(/1 completed — 1 stabilized/)).toBeTruthy();
    expect(screen.getByText(/1 critical action\(s\) missed/)).toBeTruthy();
    expect(screen.getByText('Post-op day 2: sudden dyspnea')).toBeTruthy();
  });

  it('never predicts a grade anywhere on the page (spec R)', async () => {
    await render(<AnalyticsScreen courseId="course-1" />);
    await screen.findByText('Exam readiness');
    expect(screen.queryByText(/you will (get|score|pass)/i)).toBeNull();
    expect(screen.queryByText(/predicted grade/i)).toBeNull();
  });

  it('shows the honest empty state with a way forward (spec AI)', async () => {
    mocked(analyticsApi.loadAnalyticsInput).mockResolvedValue({
      ...buildInput(),
      attempts: [],
      simulations: [],
      sessions: [],
      mastery: [],
    });
    await render(<AnalyticsScreen courseId="course-1" />);
    await screen.findByText('Nothing to analyze yet');
    await fireEvent.press(screen.getByText('Start practicing'));
    expect(mockRouter.push).toHaveBeenCalledWith('/course/course-1/practice?mode=adaptive');
  });

  it('shows an error with retry when loading fails', async () => {
    mocked(analyticsApi.loadAnalyticsInput).mockRejectedValue(new Error('network'));
    await render(<AnalyticsScreen courseId="course-1" />);
    await screen.findByText('We could not load your analytics. Please try again.');
    expect(screen.getByText('Retry')).toBeTruthy();
  });
});
