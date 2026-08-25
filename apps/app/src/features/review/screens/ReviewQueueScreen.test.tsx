import { fireEvent, render, screen } from '@testing-library/react-native';

import { ReviewQueueScreen } from './ReviewQueueScreen';
import type { ReviewApiError, ReviewQuestion } from '../reviewApi';

/**
 * Content-review queue UI tests. `getSupabase`, `expo-router`'s
 * `useFocusEffect`, and the `reviewApi` client are mocked — these pin the
 * screen's states (loading/forbidden/error/empty/loaded) and that a reviewer
 * action sends the request `reviewApi` expects (see reviewApi.test.ts for
 * that contract, and supabase/functions/content-review/index.ts server-side).
 */

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual('react');
  return {
    useFocusEffect: (cb: () => void | (() => void)) => {
      useEffect(() => {
        return cb();
      }, [cb]);
    },
  };
});

jest.mock('../../../lib/supabase', () => ({
  getSupabase: () => ({ mocked: true }),
}));

jest.mock('../reviewApi', () => ({
  fetchReviewQueue: jest.fn(),
  decideReviewQuestion: jest.fn(),
}));

import * as reviewApi from '../reviewApi';

const mocked = <T,>(fn: T) => fn as jest.Mock;

const sampleQuestion: ReviewQuestion = {
  id: 'q-1',
  course_id: 'course-1',
  courses: { title: 'Med-Surg I' },
  concept_id: null,
  question_type: 'single_best_answer',
  stem: 'A client reports chest pain. What is the priority nursing action?',
  difficulty: 'moderate',
  cognitive_level: 'prioritization',
  source_type: 'course_grounded',
  generation_source: 'document_pipeline',
  priority_frameworks: ['abc'],
  rationale: 'Airway/breathing/circulation always comes first.',
  expected_value: null,
  tolerance: null,
  answer_unit: null,
  rounding_note: null,
  status: 'flagged',
  safety_flags: ['low_confidence'],
  content_hash: 'abc123',
  created_at: '2026-08-20T00:00:00Z',
  updated_at: '2026-08-20T00:00:00Z',
  question_options: [
    {
      id: 'o-1',
      ordinal: 1,
      option_text: 'Call the provider',
      is_correct: false,
      correct_position: null,
      rationale: 'Wrong: assess first.',
    },
    {
      id: 'o-2',
      ordinal: 2,
      option_text: 'Assess vital signs',
      is_correct: true,
      correct_position: null,
      rationale: 'Correct: ABC.',
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ReviewQueueScreen', () => {
  it('shows an honest empty state when nothing is waiting for review', async () => {
    mocked(reviewApi.fetchReviewQueue).mockResolvedValue([]);
    await render(<ReviewQueueScreen />);
    await screen.findByText('Queue is empty');
  });

  it('lists a question and lets a reviewer approve it with no edits', async () => {
    mocked(reviewApi.fetchReviewQueue).mockResolvedValue([sampleQuestion]);
    mocked(reviewApi.decideReviewQuestion).mockResolvedValue(undefined);
    await render(<ReviewQueueScreen />);
    await screen.findByText('Med-Surg I');
    expect(screen.getByText('Flagged')).toBeTruthy();
    expect(screen.getByText(/Flagged for: low_confidence/)).toBeTruthy();

    await fireEvent.press(screen.getByText('Approve'));
    expect(reviewApi.decideReviewQuestion).toHaveBeenCalledWith({ mocked: true }, 'q-1', {
      decision: 'approve',
      edits: undefined,
    });
    // Decided questions leave the queue immediately (no re-fetch).
    await screen.findByText('Queue is empty');
  });

  it('sends only the changed field when saving an edit', async () => {
    mocked(reviewApi.fetchReviewQueue).mockResolvedValue([sampleQuestion]);
    mocked(reviewApi.decideReviewQuestion).mockResolvedValue(undefined);
    await render(<ReviewQueueScreen />);
    await screen.findByText('Med-Surg I');

    await fireEvent.changeText(
      screen.getByLabelText('Stem'),
      'A client reports crushing chest pain radiating to the jaw. What is the priority nursing action?'
    );
    await fireEvent.press(screen.getByText('Save edits'));
    expect(reviewApi.decideReviewQuestion).toHaveBeenCalledWith({ mocked: true }, 'q-1', {
      decision: undefined,
      edits: {
        stem: 'A client reports crushing chest pain radiating to the jaw. What is the priority nursing action?',
      },
    });
    // Saving an edit is not a decision — the card stays in the queue.
    expect(screen.queryByText('Queue is empty')).toBeNull();
  });

  it('shows the reviewer-access message when the caller is not a reviewer', async () => {
    const error: ReviewApiError = { status: 403, message: 'You do not have reviewer access.' };
    mocked(reviewApi.fetchReviewQueue).mockRejectedValue(error);
    await render(<ReviewQueueScreen />);
    await screen.findByText('Reviewer access required');
    expect(screen.getByText('You do not have reviewer access.')).toBeTruthy();
  });

  it('shows a retry option on a generic failure', async () => {
    const error: ReviewApiError = {
      status: 0,
      message: 'Content review is unavailable right now.',
    };
    mocked(reviewApi.fetchReviewQueue).mockRejectedValue(error);
    await render(<ReviewQueueScreen />);
    await screen.findByText('Content review is unavailable right now.');
    mocked(reviewApi.fetchReviewQueue).mockResolvedValue([]);
    await fireEvent.press(screen.getByText('Retry'));
    await screen.findByText('Queue is empty');
  });
});
