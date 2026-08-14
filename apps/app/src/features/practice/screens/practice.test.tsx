import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { PracticeScreen } from './PracticeScreen';
import type { AttemptResult, PracticeQuestionRow } from '../practiceApi';

/**
 * Practice flow tests (M7 spec V/W/X/U/AH: UI). Router, auth, supabase and
 * the data-access module are mocked; these tests verify the student-facing
 * flow: honest empty state, session start, answering each question type with
 * server-side scoring, locked answers with rationales revealed only after
 * submission, optional confidence, flagging, and a plain results screen with
 * no mastery labels.
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

jest.mock('../../courses/coursesApi', () => ({
  fetchOwnCourse: jest.fn(),
}));
jest.mock('../practiceApi', () => ({
  listActiveQuestions: jest.fn(),
  createStudySession: jest.fn(),
  submitAttempt: jest.fn(),
  closeStudySession: jest.fn(),
  submitQuestionFeedback: jest.fn(),
  // M9 daily-session plumbing.
  findResumableSession: jest.fn(),
  insertSessionPlan: jest.fn(),
  listSessionPlan: jest.fn(),
  listSessionAttempts: jest.fn(),
  markPlanSkipped: jest.fn(),
  listQuestionSourceRefs: jest.fn(),
}));
jest.mock('../../concepts/conceptsApi', () => ({
  listConcepts: jest.fn(),
}));
jest.mock('../../profile/useTimezone', () => ({
  useUserTimezone: () => 'America/Chicago',
}));
// Keep the pure assembly helpers real; mock only the fetchers (M8 adaptive).
jest.mock('../../study/studyApi', () => ({
  ...jest.requireActual('../../study/studyApi'),
  listConceptMastery: jest.fn(),
  listCourseAttempts: jest.fn(),
  listCourseExams: jest.fn(),
}));

import * as coursesApi from '../../courses/coursesApi';
import { bufferedEvents, resetAnalytics } from '../../../lib/analytics';
import * as conceptsApi from '../../concepts/conceptsApi';
import * as practiceApi from '../practiceApi';
import * as studyApi from '../../study/studyApi';

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

const sbaQuestion: PracticeQuestionRow = {
  id: 'question-1',
  course_id: 'course-1',
  concept_id: 'concept-1',
  question_type: 'single_best_answer',
  stem:
    'A client with a serum potassium of 6.4 mEq/L develops peaked T waves. ' +
    'Which action should the nurse take first?',
  difficulty: 'hard',
  cognitive_level: 'prioritization',
  source_type: 'course_grounded',
  priority_frameworks: ['abc'],
  options: [
    { id: 'option-1', ordinal: 1, option_text: 'Administer IV calcium gluconate' },
    { id: 'option-2', ordinal: 2, option_text: 'Restrict dietary potassium' },
    { id: 'option-3', ordinal: 3, option_text: 'Document the finding' },
  ],
};

const calcQuestion: PracticeQuestionRow = {
  id: 'question-2',
  course_id: 'course-1',
  concept_id: 'concept-2',
  question_type: 'numeric_calculation',
  stem:
    'A provider prescribes furosemide 40 mg by mouth. Tablets contain 20 mg. ' +
    'How many tablets should the nurse administer?',
  difficulty: 'easy',
  cognitive_level: 'application',
  source_type: 'course_grounded',
  priority_frameworks: [],
  options: [],
};

const sbaResult: AttemptResult = {
  is_correct: true,
  rationale:
    'IV calcium gluconate stabilizes the cardiac membrane first; potassium-lowering follows.',
  expected_value: null,
  tolerance: null,
  answer_unit: null,
  rounding_note: null,
  options: [
    { id: 'option-1', ordinal: 1, is_correct: true, correct_position: null, rationale: null },
    {
      id: 'option-2',
      ordinal: 2,
      is_correct: false,
      correct_position: null,
      rationale: 'Dietary restriction is far too slow for ECG changes.',
    },
    {
      id: 'option-3',
      ordinal: 3,
      is_correct: false,
      correct_position: null,
      rationale: 'Documentation alone does not treat the emergency.',
    },
  ],
};

const calcResult: AttemptResult = {
  is_correct: false,
  rationale: 'Divide the ordered dose by the tablet strength: 40 mg ÷ 20 mg = 2 tablets.',
  expected_value: 2,
  tolerance: 0,
  answer_unit: 'tablets',
  rounding_note: 'Whole tablets only.',
  options: [],
};

const session = {
  id: 'session-1',
  course_id: 'course-1',
  session_type: 'practice',
  status: 'in_progress' as const,
  planned_question_count: 2,
  started_at: '2026-08-13T00:00:00.000Z',
  completed_at: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  resetAnalytics();
  mocked(coursesApi.fetchOwnCourse).mockResolvedValue(course);
  mocked(practiceApi.createStudySession).mockResolvedValue(session);
  mocked(practiceApi.closeStudySession).mockResolvedValue(undefined);
  mocked(practiceApi.submitQuestionFeedback).mockResolvedValue(undefined);
  // M9 defaults: no open session, plan writes succeed, no stored sources.
  mocked(practiceApi.findResumableSession).mockResolvedValue(null);
  mocked(practiceApi.insertSessionPlan).mockResolvedValue(undefined);
  mocked(practiceApi.listSessionPlan).mockResolvedValue([]);
  mocked(practiceApi.listSessionAttempts).mockResolvedValue([]);
  mocked(practiceApi.markPlanSkipped).mockResolvedValue(undefined);
  mocked(practiceApi.listQuestionSourceRefs).mockResolvedValue([]);
});

describe('PracticeScreen setup', () => {
  it('shows an honest empty state before any questions exist', async () => {
    mocked(practiceApi.listActiveQuestions).mockResolvedValue([]);
    await render(<PracticeScreen courseId="course-1" />);
    await screen.findByText(/No practice questions yet/);
    expect(screen.queryByText(/questions available/)).toBeNull();
  });

  it('offers session sizes capped at the pool size', async () => {
    mocked(practiceApi.listActiveQuestions).mockResolvedValue([sbaQuestion, calcQuestion]);
    await render(<PracticeScreen courseId="course-1" />);
    await screen.findByText(
      '2 questions available from your course materials. Choose a session length — questions are mixed across the topics your materials cover.'
    );
    // Only the smallest size choice remains, capped to the pool of 2.
    expect(screen.getByText('2 questions')).toBeTruthy();
    expect(screen.queryByText('10 questions')).toBeNull();
  });

  it('shows an error with a retry when loading fails', async () => {
    mocked(practiceApi.listActiveQuestions).mockRejectedValue(new Error('network'));
    await render(<PracticeScreen courseId="course-1" />);
    await screen.findByText('We could not load practice questions. Please try again.');
    expect(screen.getByText('Retry')).toBeTruthy();
  });
});

describe('PracticeScreen session flow (spec V/W/X)', () => {
  async function startTwoQuestionSession() {
    mocked(practiceApi.listActiveQuestions).mockResolvedValue([sbaQuestion, calcQuestion]);
    await render(<PracticeScreen courseId="course-1" />);
    await screen.findByText('2 questions');
    await fireEvent.press(screen.getByText('2 questions'));
    await screen.findByText('Question 1 of 2');
  }

  it('answers cannot be submitted empty, and rationales appear only after submission', async () => {
    mocked(practiceApi.submitAttempt).mockResolvedValue(sbaResult);
    await startTwoQuestionSession();

    // Nothing about the correct answer is on screen before submission.
    expect(screen.queryByText(/calcium gluconate stabilizes/)).toBeNull();

    // Determine which question came first (deterministic mix by session id).
    const first = screen.queryByText(/Which action should the nurse take first/)
      ? sbaQuestion
      : calcQuestion;
    if (first.id === sbaQuestion.id) {
      await fireEvent.press(screen.getByText('Administer IV calcium gluconate'));
      await fireEvent.press(screen.getByText('Submit answer'));
      await screen.findByText(/stabilizes the cardiac membrane/);
      expect(mocked(practiceApi.submitAttempt).mock.calls[0]![3]).toEqual({
        selected_option_ids: ['option-1'],
      });
      // The answer is locked: the submit button is gone.
      expect(screen.queryByText('Submit answer')).toBeNull();
      expect(screen.getByText('Next question')).toBeTruthy();
    } else {
      mocked(practiceApi.submitAttempt).mockResolvedValue(calcResult);
      await fireEvent.changeText(screen.getByLabelText('Your numeric answer'), '4');
      await fireEvent.press(screen.getByText('Submit answer'));
      await screen.findByText(/40 mg ÷ 20 mg = 2 tablets/);
      expect(mocked(practiceApi.submitAttempt).mock.calls[0]![3]).toEqual({ value: 4 });
      expect(screen.getByText(/Expected: 2 tablets/)).toBeTruthy();
    }
  });

  it('passes the chosen confidence level with the attempt (spec U)', async () => {
    mocked(practiceApi.submitAttempt).mockResolvedValue(sbaResult);
    await startTwoQuestionSession();
    const isSbaFirst = screen.queryByText(/Which action should the nurse take first/) !== null;
    if (isSbaFirst) {
      await fireEvent.press(screen.getByLabelText('Confidence: Pretty sure'));
      await fireEvent.press(screen.getByText('Administer IV calcium gluconate'));
    } else {
      mocked(practiceApi.submitAttempt).mockResolvedValue(calcResult);
      await fireEvent.press(screen.getByLabelText('Confidence: Pretty sure'));
      await fireEvent.changeText(screen.getByLabelText('Your numeric answer'), '2');
    }
    await fireEvent.press(screen.getByText('Submit answer'));
    await waitFor(() => expect(practiceApi.submitAttempt).toHaveBeenCalled());
    expect(mocked(practiceApi.submitAttempt).mock.calls[0]![5]).toBe('pretty_sure');
  });

  it('completes the session and shows plain results with no mastery labels', async () => {
    mocked(practiceApi.submitAttempt)
      .mockResolvedValueOnce(sbaResult)
      .mockResolvedValueOnce(calcResult);
    await startTwoQuestionSession();

    for (let index = 0; index < 2; index += 1) {
      if (screen.queryByText(/Which action should the nurse take first/)) {
        await fireEvent.press(screen.getByText('Administer IV calcium gluconate'));
      } else {
        await fireEvent.changeText(screen.getByLabelText('Your numeric answer'), '4');
      }
      await fireEvent.press(screen.getByText('Submit answer'));
      await fireEvent.press(
        index === 0
          ? await screen.findByText('Next question')
          : await screen.findByText('See results')
      );
    }

    await screen.findByText('You answered 1 of 2 correctly.');
    expect(practiceApi.closeStudySession).toHaveBeenCalledWith(
      { mocked: true },
      'session-1',
      'completed'
    );
    // Honest results only — never mastery/weakness labels (spec X/AL).
    expect(screen.queryByText(/mastered/i)).toBeNull();
    expect(screen.queryByText(/weak/i)).toBeNull();
    expect(screen.getByText('Practice again')).toBeTruthy();
  });

  it('lets the student flag a question after answering without altering it (spec AH)', async () => {
    mocked(practiceApi.submitAttempt).mockResolvedValue(sbaResult);
    await startTwoQuestionSession();
    if (screen.queryByText(/Which action should the nurse take first/)) {
      await fireEvent.press(screen.getByText('Administer IV calcium gluconate'));
    } else {
      mocked(practiceApi.submitAttempt).mockResolvedValue(calcResult);
      await fireEvent.changeText(screen.getByLabelText('Your numeric answer'), '2');
    }
    await fireEvent.press(screen.getByText('Submit answer'));
    await fireEvent.press(await screen.findByText('Report a problem'));
    await fireEvent.press(screen.getByLabelText('Reason: The question is unclear'));
    await fireEvent.press(screen.getByText('Send report'));
    await screen.findByText(/flagged for review/);
    expect(mocked(practiceApi.submitQuestionFeedback).mock.calls[0]![3]).toBe('question_unclear');
  });

  it('navigates back to the course from the setup screen', async () => {
    mocked(practiceApi.listActiveQuestions).mockResolvedValue([sbaQuestion]);
    await render(<PracticeScreen courseId="course-1" />);
    await screen.findByText('Back to course');
    await fireEvent.press(screen.getByText('Back to course'));
    expect(mockRouter.push).toHaveBeenCalledWith('/course/course-1');
  });
});

describe('PracticeScreen adaptive mode (M8 spec U/V/W)', () => {
  const concepts = [
    {
      id: 'concept-1',
      course_id: 'course-1',
      canonical_name: 'Hyperkalemia management',
      concept_type: 'condition',
      summary: null,
      status: 'active',
      emphasis_score: 8,
      source_count: 2,
    },
    {
      id: 'concept-2',
      course_id: 'course-1',
      canonical_name: 'Dosage calculation',
      concept_type: 'skill',
      summary: null,
      status: 'active',
      emphasis_score: 4,
      source_count: 1,
    },
  ];

  beforeEach(() => {
    mocked(conceptsApi.listConcepts).mockResolvedValue(concepts);
    mocked(studyApi.listConceptMastery).mockResolvedValue([]);
    mocked(studyApi.listCourseAttempts).mockResolvedValue([]);
    mocked(studyApi.listCourseExams).mockResolvedValue([]);
  });

  const adaptiveSession = { ...session, session_type: 'adaptive' };

  async function startFiveMinuteSession() {
    mocked(practiceApi.listActiveQuestions).mockResolvedValue([sbaQuestion, calcQuestion]);
    mocked(practiceApi.createStudySession).mockResolvedValue(adaptiveSession);
    await render(<PracticeScreen courseId="course-1" mode="adaptive" />);
    await screen.findByText(/Adaptive study — Adult Health I/);
    expect(screen.getByText(/picked for the topics that most need your attention/)).toBeTruthy();
    await fireEvent.press(screen.getByText('5 min'));
    // A 5-minute plan wants 4 questions but the pool of 2 caps it (spec X).
    await screen.findByText('Question 1 of 2');
  }

  it('creates an adaptive session from a duration and persists the plan (spec B/D/O)', async () => {
    await startFiveMinuteSession();

    // The session row was created as 'adaptive' with the requested duration…
    expect(mocked(practiceApi.createStudySession).mock.calls[0]![2]).toBe(2);
    expect(mocked(practiceApi.createStudySession).mock.calls[0]![3]).toBe('adaptive');
    expect(mocked(practiceApi.createStudySession).mock.calls[0]![4]).toBe(5);
    // …its plan was stored for resume (spec O)…
    const planCall = mocked(practiceApi.insertSessionPlan).mock.calls[0]!;
    expect(planCall[1]).toBe('session-1');
    expect([...(planCall[2] as string[])].sort()).toEqual(['question-1', 'question-2']);
    // …and selection used only the student's own persisted rows.
    expect(conceptsApi.listConcepts).toHaveBeenCalled();
    expect(studyApi.listConceptMastery).toHaveBeenCalled();
    expect(studyApi.listCourseAttempts).toHaveBeenCalled();
    expect(studyApi.listCourseExams).toHaveBeenCalled();
    // Privacy-conscious analytics: names and counts only (spec Z).
    expect(bufferedEvents()).toContainEqual({
      name: 'daily_session_started',
      requestedMinutes: 5,
      plannedQuestions: 2,
    });
  });

  it('still starts the session when plan persistence fails (spec W)', async () => {
    mocked(practiceApi.insertSessionPlan).mockRejectedValue(new Error('network'));
    await startFiveMinuteSession();
    expect(screen.getByText(/Question 1 of 2/)).toBeTruthy();
  });

  it('skip is tracked explicitly and never scored (spec AB)', async () => {
    await startFiveMinuteSession();
    await fireEvent.press(screen.getByText('Skip for now'));
    await screen.findByText('Question 2 of 2');
    await waitFor(() => expect(practiceApi.markPlanSkipped).toHaveBeenCalled());
    expect(mocked(practiceApi.markPlanSkipped).mock.calls[0]![1]).toBe('session-1');
    expect(practiceApi.submitAttempt).not.toHaveBeenCalled();
  });

  it('offers to resume an open session instead of silently discarding it (spec O)', async () => {
    mocked(practiceApi.listActiveQuestions).mockResolvedValue([sbaQuestion, calcQuestion]);
    mocked(practiceApi.findResumableSession).mockResolvedValue(adaptiveSession);
    await render(<PracticeScreen courseId="course-1" mode="adaptive" />);
    await screen.findByText('You have a session in progress');
    expect(screen.getByText('Continue session')).toBeTruthy();
  });

  it('resume continues from the stored plan without re-answering or a new session (spec O)', async () => {
    mocked(practiceApi.listActiveQuestions).mockResolvedValue([sbaQuestion, calcQuestion]);
    mocked(practiceApi.findResumableSession).mockResolvedValue(adaptiveSession);
    mocked(practiceApi.listSessionPlan).mockResolvedValue([
      { position: 1, question_id: 'question-1', skipped_at: null },
      { position: 2, question_id: 'question-2', skipped_at: null },
    ]);
    mocked(practiceApi.listSessionAttempts).mockResolvedValue([
      { question_id: 'question-1', is_correct: true },
    ]);
    await render(<PracticeScreen courseId="course-1" mode="adaptive" resume />);
    // Only the unanswered question remains; no duplicate session row is made.
    await screen.findByText('Question 1 of 1');
    expect(screen.getByText(/furosemide 40 mg/)).toBeTruthy();
    expect(practiceApi.createStudySession).not.toHaveBeenCalled();
  });

  it('shows the source reference on demand after answering (spec T/G)', async () => {
    mocked(practiceApi.submitAttempt).mockResolvedValue(sbaResult);
    mocked(practiceApi.listQuestionSourceRefs).mockResolvedValue([
      {
        document_filename: 'cardiac-week3.pptx',
        source_locator: { type: 'slide', slide: 4 },
      },
    ]);
    await startFiveMinuteSession();
    if (screen.queryByText(/Which action should the nurse take first/)) {
      await fireEvent.press(screen.getByText('Administer IV calcium gluconate'));
    } else {
      mocked(practiceApi.submitAttempt).mockResolvedValue(calcResult);
      await fireEvent.changeText(screen.getByLabelText('Your numeric answer'), '2');
    }
    await fireEvent.press(screen.getByText('Submit answer'));
    await fireEvent.press(await screen.findByText('View source'));
    await screen.findByText('Based on: cardiac-week3.pptx — Slide 4');
    expect(practiceApi.listQuestionSourceRefs).toHaveBeenCalled();
    expect(bufferedEvents()).toContainEqual({ name: 'source_viewed' });
  });

  it('ends with an honest adaptive summary — no fake precision (spec M)', async () => {
    mocked(practiceApi.submitAttempt).mockImplementation((_c, _s, questionId: string) =>
      Promise.resolve(questionId === 'question-1' ? sbaResult : calcResult)
    );
    await startFiveMinuteSession();
    for (let index = 0; index < 2; index += 1) {
      if (screen.queryByText(/Which action should the nurse take first/)) {
        await fireEvent.press(screen.getByText('Administer IV calcium gluconate'));
      } else {
        await fireEvent.changeText(screen.getByLabelText('Your numeric answer'), '4');
      }
      await fireEvent.press(screen.getByText('Submit answer'));
      await fireEvent.press(
        index === 0
          ? await screen.findByText('Next question')
          : await screen.findByText('See results')
      );
    }
    await screen.findByText(/You completed 2 activities — 1 correct\./);
    expect(practiceApi.closeStudySession).toHaveBeenCalledWith(
      { mocked: true },
      'session-1',
      'completed'
    );
    // No mastery percentages or grade labels anywhere (spec M).
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.getByText('Back to Today')).toBeTruthy();
    expect(bufferedEvents()).toContainEqual({
      name: 'daily_session_completed',
      answeredCount: 2,
      skippedCount: 0,
    });
  });

  it('in practice mode, never touches mastery or exam data (M7 behavior preserved)', async () => {
    mocked(practiceApi.listActiveQuestions).mockResolvedValue([sbaQuestion, calcQuestion]);
    await render(<PracticeScreen courseId="course-1" />);
    await screen.findByText('2 questions');
    await fireEvent.press(screen.getByText('2 questions'));
    await screen.findByText('Question 1 of 2');
    expect(mocked(practiceApi.createStudySession).mock.calls[0]![3]).toBe('practice');
    expect(studyApi.listConceptMastery).not.toHaveBeenCalled();
    expect(studyApi.listCourseExams).not.toHaveBeenCalled();
  });
});
