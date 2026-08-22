import { fireEvent, render, screen } from '@testing-library/react-native';

import { StudyDashboardScreen } from './StudyDashboardScreen';

/**
 * Minimal mastery dashboard tests (M8 spec AF/AG/AH): one upcoming exam, one
 * recommended next action with honest reasons, concepts grouped by coarse
 * state — and never a percentage, score, or prediction on screen.
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
}));
jest.mock('../../concepts/conceptsApi', () => ({
  listConcepts: jest.fn(),
}));
jest.mock('../../practice/practiceApi', () => ({
  listActiveQuestions: jest.fn(),
}));
jest.mock('../studyApi', () => ({
  ...jest.requireActual('../studyApi'),
  listConceptMastery: jest.fn(),
  listCourseAttempts: jest.fn(),
  listCourseExams: jest.fn(),
}));
jest.mock('../../aiLearning/aiLearningApi', () => ({
  listLearningRequests: jest.fn(),
  requestLearningArtifact: jest.fn(),
}));

import * as coursesApi from '../../courses/coursesApi';
import * as conceptsApi from '../../concepts/conceptsApi';
import * as practiceApi from '../../practice/practiceApi';
import * as studyApi from '../studyApi';
import * as aiLearningApi from '../../aiLearning/aiLearningApi';

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

const concepts = [
  {
    id: 'c1',
    course_id: 'course-1',
    canonical_name: 'Hyperkalemia management',
    concept_type: 'condition',
    summary: null,
    status: 'active',
    emphasis_score: 8,
    source_count: 2,
  },
  {
    id: 'c2',
    course_id: 'course-1',
    canonical_name: 'Insulin administration',
    concept_type: 'skill',
    summary: null,
    status: 'active',
    emphasis_score: 4,
    source_count: 1,
  },
];

const questions = [
  {
    id: 'q1',
    course_id: 'course-1',
    concept_id: 'c1',
    question_type: 'single_best_answer',
    stem: 'stem',
    difficulty: 'moderate',
    cognitive_level: 'application',
    source_type: 'course_grounded',
    priority_frameworks: [],
    options: [],
  },
];

// Times are relative to the real clock so the states are stable whenever the
// suite runs: c1 was answered incorrectly, sits low, and is NOT yet due for
// its spaced review → needs review; c2 is well-practiced → strong.
const HOUR = 3600_000;
const recentIso = new Date(Date.now() - 2 * HOUR).toISOString();
const masteryRows = [
  {
    concept_id: 'c1',
    mastery: 0.2,
    attempts_count: 3,
    correct_count: 0,
    misconception_severity: 0,
    review_stage: 0,
    last_attempt_at: recentIso,
    next_review_at: new Date(Date.now() + 22 * HOUR).toISOString(),
    algorithm_version: 1,
  },
  {
    concept_id: 'c2',
    mastery: 0.9,
    attempts_count: 10,
    correct_count: 9,
    misconception_severity: 0,
    review_stage: 2,
    last_attempt_at: recentIso,
    next_review_at: new Date(Date.now() + 7 * 24 * HOUR).toISOString(),
    algorithm_version: 1,
  },
];

const attempts = [{ question_id: 'q1', is_correct: false, created_at: recentIso }];

// One future exam relative to the real clock in test runs.
const futureIso = new Date(Date.now() + 2 * 24 * 3600_000).toISOString();
const exams = [{ id: 'e1', title: 'Exam 2 — Endocrine', exam_at: futureIso }];

beforeEach(() => {
  jest.clearAllMocks();
  mocked(coursesApi.fetchOwnCourse).mockResolvedValue(course);
  mocked(conceptsApi.listConcepts).mockResolvedValue(concepts);
  mocked(practiceApi.listActiveQuestions).mockResolvedValue(questions);
  mocked(studyApi.listConceptMastery).mockResolvedValue(masteryRows);
  mocked(studyApi.listCourseAttempts).mockResolvedValue(attempts);
  mocked(studyApi.listCourseExams).mockResolvedValue(exams);
  mocked(aiLearningApi.listLearningRequests).mockResolvedValue([]);
});

describe('StudyDashboardScreen (spec AF)', () => {
  it('shows the upcoming exam, one recommendation with reasons, and grouped states', async () => {
    await render(<StudyDashboardScreen courseId="course-1" />);

    await screen.findByText('Recommended next');
    // Upcoming exam with a countdown, not a raw timestamp.
    expect(screen.getByText('Exam 2 — Endocrine')).toBeTruthy();
    // The weak, exam-soon concept is the recommended action (it renders in
    // both the recommendation card and its state group).
    expect(screen.getAllByText('Hyperkalemia management')).toHaveLength(2);
    // …with honest reason codes rendered as plain language.
    expect(screen.getByText(/Recent answers suggest a gap here/)).toBeTruthy();
    expect(screen.getByText(/Relevant to an upcoming exam/)).toBeTruthy();
    // Grouped coarse states with counts of concepts.
    expect(screen.getByText('Needs review (1)')).toBeTruthy();
    expect(screen.getByText('Strong (1)')).toBeTruthy();
  });

  it('never shows percentages, scores, or predictions (spec AG)', async () => {
    await render(<StudyDashboardScreen courseId="course-1" />);
    await screen.findByText('Recommended next');
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.queryByText(/0\.2/)).toBeNull();
    expect(screen.queryByText(/predict/i)).toBeNull();
    expect(screen.queryByText(/score/i)).toBeNull();
  });

  it('starts an adaptive session from the recommendation card', async () => {
    await render(<StudyDashboardScreen courseId="course-1" />);
    await screen.findByText('Start adaptive session');
    await fireEvent.press(screen.getByText('Start adaptive session'));
    expect(mockRouter.push).toHaveBeenCalledWith('/course/course-1/practice?mode=adaptive');
  });

  it('shows an honest empty state before any concepts exist (spec X cold start)', async () => {
    mocked(conceptsApi.listConcepts).mockResolvedValue([]);
    mocked(practiceApi.listActiveQuestions).mockResolvedValue([]);
    mocked(studyApi.listConceptMastery).mockResolvedValue([]);
    mocked(studyApi.listCourseAttempts).mockResolvedValue([]);
    mocked(studyApi.listCourseExams).mockResolvedValue([]);
    await render(<StudyDashboardScreen courseId="course-1" />);
    await screen.findByText(/No concepts to study yet/);
    expect(screen.queryByText('Start adaptive session')).toBeNull();
    expect(screen.getByText(/No upcoming exams/)).toBeTruthy();
  });

  describe('no-upload fallback (course name -> LLM concept list -> questions)', () => {
    beforeEach(() => {
      mocked(conceptsApi.listConcepts).mockResolvedValue([]);
      mocked(practiceApi.listActiveQuestions).mockResolvedValue([]);
      mocked(studyApi.listConceptMastery).mockResolvedValue([]);
      mocked(studyApi.listCourseAttempts).mockResolvedValue([]);
      mocked(studyApi.listCourseExams).mockResolvedValue([]);
    });

    it('offers to generate study questions from the course name when no concepts exist yet', async () => {
      mocked(aiLearningApi.requestLearningArtifact).mockResolvedValue({
        id: 'req-1',
        kind: 'question_set',
        status: 'queued',
        request: {},
        result: null,
        error_message: null,
        created_at: '2026-08-01T00:00:00.000Z',
      });
      await render(<StudyDashboardScreen courseId="course-1" />);
      await screen.findByText('Generate study questions from course name');
      await fireEvent.press(screen.getByText('Generate study questions from course name'));
      expect(aiLearningApi.requestLearningArtifact).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        'course-1',
        'question_set',
        {}
      );
      await screen.findByText(/Avidia is building a study topic list/);
    });

    it('shows a pending state (and keeps polling) when a question_set request is already queued', async () => {
      mocked(aiLearningApi.listLearningRequests).mockResolvedValue([
        {
          id: 'req-pending',
          kind: 'question_set',
          status: 'processing',
          request: {},
          result: null,
          error_message: null,
          created_at: '2026-08-01T00:00:00.000Z',
        },
      ]);
      await render(<StudyDashboardScreen courseId="course-1" />);
      await screen.findByText(/Avidia is building a study topic list/);
      expect(screen.queryByText('Generate study questions from course name')).toBeNull();
    });

    it('shows a dismissible failure and lets the student try again', async () => {
      mocked(aiLearningApi.listLearningRequests).mockResolvedValue([
        {
          id: 'req-failed',
          kind: 'question_set',
          status: 'failed',
          request: {},
          result: null,
          error_message: 'Avidia could not create that right now.',
          created_at: '2026-08-01T00:00:00.000Z',
        },
      ]);
      await render(<StudyDashboardScreen courseId="course-1" />);
      await screen.findByText(/Avidia could not generate study questions/);
      await fireEvent.press(screen.getByText('Dismiss'));
      expect(screen.queryByText(/Avidia could not generate study questions/)).toBeNull();
      expect(screen.getByText('Generate study questions from course name')).toBeTruthy();
    });
  });

  it('shows an error with retry when loading fails', async () => {
    mocked(coursesApi.fetchOwnCourse).mockRejectedValue(new Error('network'));
    await render(<StudyDashboardScreen courseId="course-1" />);
    await screen.findByText('We could not load your study plan. Please try again.');
    expect(screen.getByText('Retry')).toBeTruthy();
  });
});
