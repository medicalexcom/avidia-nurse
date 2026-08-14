import { fireEvent, render, screen } from '@testing-library/react-native';

import { ModesScreen } from './ModesScreen';
import type { PracticeQuestionRow } from '../../practice/practiceApi';

/**
 * Study-modes picker tests (M10 spec S/T/U): every mode is listed, eligible
 * modes launch with honest counts, and locked modes explain exactly what
 * unlocks them — no dead ends, no hidden features.
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

jest.mock('../../../lib/supabase', () => ({
  getSupabase: () => ({ mocked: true }),
}));

jest.mock('../../courses/coursesApi', () => ({
  fetchOwnCourse: jest.fn(),
}));
jest.mock('../../practice/practiceApi', () => ({
  listActiveQuestions: jest.fn(),
}));
jest.mock('../../concepts/conceptsApi', () => ({
  listConcepts: jest.fn(),
}));

import * as coursesApi from '../../courses/coursesApi';
import * as conceptsApi from '../../concepts/conceptsApi';
import * as practiceApi from '../../practice/practiceApi';

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

const baseQuestion: PracticeQuestionRow = {
  id: 'question-1',
  course_id: 'course-1',
  concept_id: null,
  question_type: 'single_best_answer',
  stem: 'Which client should the nurse see first?',
  difficulty: 'moderate',
  cognitive_level: 'prioritization',
  source_type: 'course_grounded',
  priority_frameworks: ['abc'],
  options: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mocked(coursesApi.fetchOwnCourse).mockResolvedValue(course);
  mocked(conceptsApi.listConcepts).mockResolvedValue([]);
});

describe('ModesScreen', () => {
  it('lists every mode; eligible ones launch, locked ones explain themselves', async () => {
    mocked(practiceApi.listActiveQuestions).mockResolvedValue(
      [1, 2, 3, 4].map((n) => ({ ...baseQuestion, id: `q-${n}` }))
    );
    await render(<ModesScreen courseId="course-1" />);
    await screen.findByText('Who First?');
    // All five modes are always visible (spec S).
    for (const title of [
      'Rapid Response',
      'Find the Danger',
      'Who First?',
      'Medication Lab',
      'Boss Battle',
    ]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    // Who First? is eligible (4 prioritization questions) with honest count.
    expect(screen.getByText('4 questions available')).toBeTruthy();
    await fireEvent.press(screen.getByText('Start Who First?'));
    expect(mockRouter.push).toHaveBeenCalledWith('/course/course-1/practice?mode=who_first');
    // Medication Lab is locked with a guiding message, not hidden (spec T).
    expect(screen.queryByText('Start Medication Lab')).toBeNull();
    expect(
      screen.getByText(/Medication Lab unlocks when your course materials cover medications/)
    ).toBeTruthy();
    // Boss Battle needs 8 questions — locked at 4.
    expect(screen.queryByText('Start Boss Battle')).toBeNull();
  });

  it('shows an error with retry when loading fails', async () => {
    mocked(practiceApi.listActiveQuestions).mockRejectedValue(new Error('network'));
    await render(<ModesScreen courseId="course-1" />);
    await screen.findByText('We could not load study modes. Please try again.');
    expect(screen.getByText('Retry')).toBeTruthy();
  });
});
