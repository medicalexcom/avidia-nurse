import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { CoursesListScreen } from './CoursesListScreen';
import { CourseDetailScreen } from './CourseDetailScreen';
import { ExamFormScreen } from './ExamFormScreen';
import type { CourseSummary } from '../coursesApi';

/**
 * Screen-level tests (spec M: UI/integration). Everything below the screen —
 * router, auth, supabase client, and the data-access modules — is mocked, so
 * these tests verify screen behavior: states, flows, confirmations, and that
 * the exact right repository calls are made (including UTC conversion).
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
const mockRouter = router as unknown as { push: jest.Mock; replace: jest.Mock; back: jest.Mock };

jest.mock('../../auth/AuthProvider', () => {
  // Stable identity: a fresh object each render would retrigger load effects.
  const user = { id: 'user-1', email: 'student@example.com' };
  return { useAuth: () => ({ user }) };
});

jest.mock('../../../lib/supabase', () => ({
  getSupabase: () => ({ mocked: true }),
}));

// Fixed timezone so date assertions are deterministic (America/Chicago,
// CDT = UTC-5 in September).
jest.mock('../../profile/useTimezone', () => ({
  useUserTimezone: () => 'America/Chicago',
  deviceTimeZone: () => 'America/Chicago',
}));

jest.mock('../coursesApi', () => ({
  listOwnCourses: jest.fn(),
  fetchOwnCourse: jest.fn(),
  createCourse: jest.fn(),
  updateOwnCourse: jest.fn(),
  archiveOwnCourse: jest.fn(),
  unarchiveOwnCourse: jest.fn(),
  deleteOwnCourse: jest.fn(),
}));
jest.mock('../modulesApi', () => ({
  listModules: jest.fn(),
  createModule: jest.fn(),
  renameModule: jest.fn(),
  saveModuleOrder: jest.fn(),
  deleteModule: jest.fn(),
}));
jest.mock('../../materials/uploadService', () => ({
  removeCourseMaterialObjects: jest.fn().mockResolvedValue(0),
}));
jest.mock('../examsApi', () => ({
  listExams: jest.fn(),
  fetchExam: jest.fn(),
  createExam: jest.fn(),
  updateExam: jest.fn(),
  setExamModules: jest.fn(),
  deleteExam: jest.fn(),
}));

import * as coursesApi from '../coursesApi';
import * as modulesApi from '../modulesApi';
import * as examsApi from '../examsApi';

const mocked = <T,>(fn: T) => fn as jest.Mock;

const course = {
  id: 'course-1',
  user_id: 'user-1',
  title: 'Pharmacology',
  term: 'Fall 2026',
  institution_name: null,
  status: 'active' as const,
  created_at: '2026-08-12T00:00:00Z',
  updated_at: '2026-08-12T00:00:00Z',
};
const summary: CourseSummary = { ...course, module_count: 2, exams: [] };
const module1 = {
  id: 'm1',
  course_id: 'course-1',
  title: 'Cardiac',
  sequence: 0,
  created_at: '',
  updated_at: '',
};

beforeEach(() => {
  jest.clearAllMocks();
  mocked(coursesApi.listOwnCourses).mockResolvedValue([]);
  mocked(coursesApi.fetchOwnCourse).mockResolvedValue(course);
  mocked(modulesApi.listModules).mockResolvedValue([module1]);
  mocked(examsApi.listExams).mockResolvedValue([]);
});

describe('CoursesListScreen', () => {
  it('shows the empty state with "Create your first course"', async () => {
    await render(<CoursesListScreen />);
    const cta = await screen.findByText('Create your first course');
    await fireEvent.press(cta);
    expect(mockRouter.push).toHaveBeenCalledWith('/course/new');
  });

  it('shows course cards with module count and next exam countdown', async () => {
    mocked(coursesApi.listOwnCourses).mockResolvedValue([
      {
        ...summary,
        exams: [{ id: 'e1', title: 'Exam 1', exam_at: '2999-01-01T15:00:00.000Z' }],
      },
    ]);
    await render(<CoursesListScreen />);
    expect(await screen.findByText('Pharmacology')).toBeTruthy();
    expect(screen.getByText('Fall 2026')).toBeTruthy();
    expect(screen.getByText('2 modules')).toBeTruthy();
    expect(screen.getByText(/Exam 1: Exam in \d+ days/)).toBeTruthy();
  });

  it('shows an error with retry when loading fails, and recovers', async () => {
    mocked(coursesApi.listOwnCourses)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([summary]);
    await render(<CoursesListScreen />);
    expect(
      await screen.findByText('We could not load your courses. Please try again.')
    ).toBeTruthy();
    await fireEvent.press(screen.getByText('Retry'));
    expect(await screen.findByText('Pharmacology')).toBeTruthy();
  });
});

describe('CourseDetailScreen', () => {
  it('guides a newly created course to its first useful study action', async () => {
    mocked(modulesApi.listModules).mockResolvedValue([]);
    mocked(examsApi.listExams).mockResolvedValue([]);
    await render(<CourseDetailScreen courseId="course-1" />);
    expect(await screen.findByText('Make this course ready to study')).toBeTruthy();
    expect(screen.getByText('Upload notes, slides, or a syllabus')).toBeTruthy();
    await fireEvent.press(screen.getByText('Add course material'));
    expect(mockRouter.push).toHaveBeenCalledWith('/course/course-1/add-material');
  });

  it('adds a module scoped to the course with the next sequence', async () => {
    mocked(modulesApi.createModule).mockResolvedValue({ ...module1, id: 'm2' });
    await render(<CourseDetailScreen courseId="course-1" />);
    await screen.findByText('Cardiac');
    await fireEvent.changeText(screen.getByLabelText('New module title'), 'Respiratory');
    await fireEvent.press(screen.getByText('Add module'));
    await waitFor(() =>
      expect(modulesApi.createModule).toHaveBeenCalledWith(
        expect.anything(),
        'course-1',
        'Respiratory',
        1
      )
    );
  });

  it('reorders modules by persisting gapless sequences', async () => {
    const module2 = { ...module1, id: 'm2', title: 'Respiratory', sequence: 1 };
    mocked(modulesApi.listModules).mockResolvedValue([module1, module2]);
    mocked(modulesApi.saveModuleOrder).mockResolvedValue(undefined);
    await render(<CourseDetailScreen courseId="course-1" />);
    await screen.findByText('Cardiac');
    await fireEvent.press(screen.getByLabelText('Move Respiratory up'));
    await waitFor(() =>
      expect(modulesApi.saveModuleOrder).toHaveBeenCalledWith(expect.anything(), [
        { id: 'm2', sequence: 0 },
        { id: 'm1', sequence: 1 },
      ])
    );
  });

  it('requires explicit confirmation (with cascade warning) before deleting the course', async () => {
    mocked(coursesApi.deleteOwnCourse).mockResolvedValue(undefined);
    await render(<CourseDetailScreen courseId="course-1" />);
    await screen.findByText('Pharmacology');
    await fireEvent.press(screen.getByText('Delete course'));
    expect(coursesApi.deleteOwnCourse).not.toHaveBeenCalled();
    expect(screen.getByText(/also deletes its 1 module\(s\)/)).toBeTruthy();
    await fireEvent.press(screen.getByText('Delete permanently'));
    await waitFor(() =>
      expect(coursesApi.deleteOwnCourse).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        'course-1'
      )
    );
    expect(mockRouter.replace).toHaveBeenCalledWith('/courses');
  });

  it('cancelling the delete confirmation deletes nothing', async () => {
    await render(<CourseDetailScreen courseId="course-1" />);
    await screen.findByText('Pharmacology');
    await fireEvent.press(screen.getByText('Delete course'));
    await fireEvent.press(screen.getByText('Cancel'));
    expect(coursesApi.deleteOwnCourse).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete permanently')).toBeNull();
  });
});

describe('ExamFormScreen', () => {
  it('creates an exam converting the local date/time to UTC and linking modules', async () => {
    mocked(examsApi.createExam).mockResolvedValue({} as never);
    await render(<ExamFormScreen courseId="course-1" />);
    await screen.findByText('Modules covered');
    await fireEvent.changeText(screen.getByLabelText('Exam title'), 'Exam 1');
    await fireEvent.changeText(screen.getByLabelText('Date (YYYY-MM-DD)'), '2026-09-04');
    await fireEvent.changeText(screen.getByLabelText('Time (HH:MM, 24-hour)'), '09:00');
    await fireEvent.changeText(screen.getByLabelText('Weight % (optional, 0–100)'), '25');
    await fireEvent.press(screen.getByLabelText('Module Cardiac'));
    await fireEvent.press(screen.getByText('Create exam'));
    await waitFor(() =>
      expect(examsApi.createExam).toHaveBeenCalledWith(
        expect.anything(),
        'course-1',
        // 09:00 America/Chicago (CDT, UTC-5) === 14:00 UTC — stored as a UTC instant.
        { title: 'Exam 1', exam_at: '2026-09-04T14:00:00.000Z', weight: 25 },
        ['m1']
      )
    );
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('shows validation errors from the domain layer instead of saving', async () => {
    await render(<ExamFormScreen courseId="course-1" />);
    await screen.findByText('Modules covered');
    await fireEvent.press(screen.getByText('Create exam'));
    expect(await screen.findByText('Exam title is required.')).toBeTruthy();
    expect(examsApi.createExam).not.toHaveBeenCalled();
  });

  it('prefills the edit form in the student timezone and saves module changes', async () => {
    mocked(examsApi.fetchExam).mockResolvedValue({
      id: 'exam-1',
      course_id: 'course-1',
      title: 'Exam 1',
      exam_at: '2026-09-04T14:00:00.000Z',
      weight: 25,
      created_at: '',
      updated_at: '',
      module_ids: ['m1'],
    });
    mocked(examsApi.updateExam).mockResolvedValue(undefined);
    await render(<ExamFormScreen examId="exam-1" />);
    await screen.findByText('Modules covered');
    // 14:00 UTC shown as 09:00 local (America/Chicago).
    expect(screen.getByLabelText('Date (YYYY-MM-DD)').props.value).toBe('2026-09-04');
    expect(screen.getByLabelText('Time (HH:MM, 24-hour)').props.value).toBe('09:00');
    // Unselect the linked module, then save.
    await fireEvent.press(screen.getByLabelText('Module Cardiac'));
    await fireEvent.press(screen.getByText('Save changes'));
    await waitFor(() =>
      expect(examsApi.updateExam).toHaveBeenCalledWith(
        expect.anything(),
        'exam-1',
        { title: 'Exam 1', exam_at: '2026-09-04T14:00:00.000Z', weight: 25 },
        []
      )
    );
  });
});
