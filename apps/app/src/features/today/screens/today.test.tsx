import { fireEvent, render, screen } from '@testing-library/react-native';

import { TodayScreen } from './TodayScreen';
import type { PracticeQuestionRow } from '../../practice/practiceApi';

/**
 * Today / Home screen tests — M9 (spec A/B/P/R/AC/AD/AE/AF).
 *
 * These verify the action-first home: guiding empty states, the START TODAY
 * duration launcher, resume offer, due-review row from M8 scheduling, top
 * priorities from the pure ranking, and the recent-session history — with no
 * AI chat box and no invented numbers.
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
jest.mock('../../concepts/conceptsApi', () => ({ listConcepts: jest.fn() }));
jest.mock('../../practice/practiceApi', () => ({
  listActiveQuestions: jest.fn(),
  findResumableSession: jest.fn(),
}));
// Keep the pure assembly helpers real; mock only the fetchers.
jest.mock('../../study/studyApi', () => ({
  ...jest.requireActual('../../study/studyApi'),
  listConceptMastery: jest.fn(),
  listCourseAttempts: jest.fn(),
  listCourseExams: jest.fn(),
}));
jest.mock('../todayApi', () => ({
  ...jest.requireActual('../todayApi'),
  listRecentSessions: jest.fn(),
}));

import { bufferedEvents, resetAnalytics } from '../../../lib/analytics';
import * as conceptsApi from '../../concepts/conceptsApi';
import * as coursesApi from '../../courses/coursesApi';
import * as practiceApi from '../../practice/practiceApi';
import * as studyApi from '../../study/studyApi';
import * as todayApi from '../todayApi';

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

const concept = {
  id: 'concept-1',
  course_id: 'course-1',
  canonical_name: 'Hyperkalemia management',
  concept_type: 'condition',
  summary: null,
  status: 'active',
  emphasis_score: 8,
  source_count: 2,
};

const question: PracticeQuestionRow = {
  id: 'question-1',
  course_id: 'course-1',
  concept_id: 'concept-1',
  question_type: 'single_best_answer',
  stem: 'Which action should the nurse take first?',
  difficulty: 'hard',
  cognitive_level: 'prioritization',
  source_type: 'course_grounded',
  priority_frameworks: ['abc'],
  options: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  resetAnalytics();
  mocked(coursesApi.listOwnCourses).mockResolvedValue([course]);
  mocked(conceptsApi.listConcepts).mockResolvedValue([concept]);
  mocked(practiceApi.listActiveQuestions).mockResolvedValue([question]);
  mocked(practiceApi.findResumableSession).mockResolvedValue(null);
  mocked(studyApi.listConceptMastery).mockResolvedValue([]);
  mocked(studyApi.listCourseAttempts).mockResolvedValue([]);
  mocked(studyApi.listCourseExams).mockResolvedValue([
    { id: 'exam-1', title: 'Exam 1', exam_at: '2099-09-01T14:00:00.000Z' },
  ]);
  mocked(todayApi.listRecentSessions).mockResolvedValue([]);
});

describe('TodayScreen empty states (spec AD)', () => {
  it('guides course creation when no courses exist', async () => {
    mocked(coursesApi.listOwnCourses).mockResolvedValue([]);
    await render(<TodayScreen />);
    await screen.findByText(/Create your first course to start studying/);
    await fireEvent.press(screen.getByText('Create your first course'));
    expect(mockRouter.push).toHaveBeenCalledWith('/courses');
  });

  it('guides material upload when the course has no questions yet', async () => {
    mocked(practiceApi.listActiveQuestions).mockResolvedValue([]);
    await render(<TodayScreen />);
    await screen.findByText('Add material to unlock daily study');
    await fireEvent.press(screen.getByText('Upload course material'));
    expect(mockRouter.push).toHaveBeenCalledWith('/course/course-1/add-material');
  });
});

describe('TodayScreen action-first home (spec A/B/AE)', () => {
  it('shows START TODAY durations and launches an adaptive session', async () => {
    await render(<TodayScreen />);
    await screen.findByText('Start today');
    // The four fixed durations (spec B) — and no AI chat input (spec AE).
    for (const minutes of [5, 10, 20, 45]) {
      expect(screen.getByText(`${minutes} min`)).toBeTruthy();
    }
    await fireEvent.press(screen.getByText('20 min'));
    expect(mockRouter.push).toHaveBeenCalledWith(
      '/course/course-1/practice?mode=adaptive&minutes=20'
    );
    // 20-minute launches are daily sessions, not "quick" ones (spec Z).
    expect(bufferedEvents()).toEqual([]);
  });

  it('marks short launches as quick sessions in analytics (spec N/Z)', async () => {
    await render(<TodayScreen />);
    await screen.findByText('Start today');
    await fireEvent.press(screen.getByText('5 min'));
    expect(bufferedEvents()).toContainEqual({
      name: 'quick_session_started',
      requestedMinutes: 5,
    });
    expect(mockRouter.push).toHaveBeenCalledWith(
      '/course/course-1/practice?mode=adaptive&minutes=5'
    );
  });

  it('shows the next exam countdown and top priorities without scores (spec A)', async () => {
    await render(<TodayScreen />);
    await screen.findByText('Exam 1');
    await screen.findByText("Today's priorities");
    expect(screen.getByText('Hyperkalemia management')).toBeTruthy();
    // Counts and labels only — never percentages (spec A/M).
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('offers to continue an in-progress session (spec O)', async () => {
    mocked(practiceApi.findResumableSession).mockResolvedValue({
      id: 'session-1',
      course_id: 'course-1',
      session_type: 'adaptive',
      status: 'in_progress',
      planned_question_count: 4,
      started_at: '2026-08-13T00:00:00.000Z',
      completed_at: null,
    });
    await render(<TodayScreen />);
    await screen.findByText('You have a session in progress');
    await fireEvent.press(screen.getByText('Continue your session'));
    expect(mockRouter.push).toHaveBeenCalledWith(
      '/course/course-1/practice?mode=adaptive&resume=1'
    );
  });

  it('shows the due-review row from stored scheduling and recent history (spec R/AC)', async () => {
    mocked(studyApi.listConceptMastery).mockResolvedValue([
      {
        concept_id: 'concept-1',
        mastery: 0.4,
        attempts_count: 3,
        correct_count: 1,
        misconception_severity: 0,
        review_stage: 1,
        last_attempt_at: '2026-08-10T00:00:00.000Z',
        next_review_at: '2026-08-12T00:00:00.000Z',
        algorithm_version: 1,
      },
    ]);
    mocked(todayApi.listRecentSessions).mockResolvedValue([
      {
        id: 'session-9',
        session_type: 'adaptive',
        status: 'completed',
        requested_duration_minutes: 10,
        started_at: '2026-08-11T15:00:00.000Z',
        completed_at: '2026-08-11T15:12:00.000Z',
        attempt_count: 8,
      },
    ]);
    await render(<TodayScreen />);
    await screen.findByText('Due for review: 1 concept');
    await screen.findByText('Recent sessions');
    expect(screen.getByText(/8 questions/)).toBeTruthy();
    await fireEvent.press(screen.getByText('Review now'));
    expect(mockRouter.push).toHaveBeenCalledWith(
      '/course/course-1/practice?mode=adaptive&minutes=10'
    );
  });
});
