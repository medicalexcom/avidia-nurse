import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { AskAvidiaScreen } from './AskAvidiaScreen';

/**
 * Ask Avidia UI tests (fix for: user messages appeared but no assistant
 * reply ever did). These cover the two client-side symptoms of that bug:
 * the screen never polled for the async worker's reply, and it never
 * surfaced a failed request — a student just saw silence either way.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

jest.mock('../../auth/AuthProvider', () => {
  const user = { id: 'user-1', email: 'student@example.com' };
  return { useAuth: () => ({ user }) };
});

jest.mock('../../../lib/supabase', () => ({
  getSupabase: () => ({ mocked: true }),
}));

jest.mock('../aiLearningApi', () => ({
  ...jest.requireActual('../aiLearningApi'),
  getOrCreateConversation: jest.fn(),
  listTutorMessages: jest.fn(),
  sendTutorMessage: jest.fn(),
  getLearningRequestById: jest.fn(),
}));

import * as aiLearningApi from '../aiLearningApi';

const mocked = <T,>(fn: T) => fn as jest.Mock;

const conversation = { id: 'conversation-1', title: 'Ask Avidia', context: {} };
const userMessage = {
  id: 'm-user',
  role: 'user' as const,
  content: 'when does HIV is considered AIDS?',
  source_chunk_ids: [],
  task: null,
  model_tier: null,
  created_at: '2026-08-16T00:00:00.000Z',
};
const assistantMessage = {
  id: 'm-assistant',
  role: 'assistant' as const,
  content: 'HIV is classified as AIDS once CD4 count falls below 200 cells/mm3.',
  source_chunk_ids: ['chunk-1'],
  grounding: 'course_grounded' as const,
  task: 'RAG_ANSWER',
  model_tier: 'STANDARD',
  created_at: '2026-08-16T00:00:05.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mocked(aiLearningApi.getOrCreateConversation).mockResolvedValue(conversation);
  mocked(aiLearningApi.listTutorMessages).mockResolvedValue([]);
});

describe('AskAvidiaScreen', () => {
  it('polls automatically and shows the assistant reply once the worker finishes — no manual refresh required', async () => {
    mocked(aiLearningApi.sendTutorMessage).mockResolvedValue({
      id: 'request-1',
      kind: 'tutor',
      status: 'queued',
      request: {},
      result: null,
      error_message: null,
      created_at: '2026-08-16T00:00:00.000Z',
    });
    mocked(aiLearningApi.listTutorMessages)
      .mockResolvedValueOnce([]) // initial load
      .mockResolvedValueOnce([userMessage]) // after send()
      .mockResolvedValueOnce([userMessage, assistantMessage]); // after the poll sees status=ready
    mocked(aiLearningApi.getLearningRequestById).mockResolvedValue({
      id: 'request-1',
      kind: 'tutor',
      status: 'ready',
      request: {},
      result: {},
      error_message: null,
      created_at: '2026-08-16T00:00:00.000Z',
    });

    await render(<AskAvidiaScreen courseId="course-1" />);
    await waitFor(() => expect(aiLearningApi.listTutorMessages).toHaveBeenCalled());
    await fireEvent.changeText(
      screen.getByPlaceholderText("Ask about your course, a concept, or what you're studying..."),
      'when does HIV is considered AIDS?'
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Ask Avidia' }));

    await screen.findByText(assistantMessage.content);
    expect(screen.queryByText('Thinking…')).toBeNull();
    expect(aiLearningApi.getLearningRequestById).toHaveBeenCalledWith(
      expect.anything(),
      'request-1'
    );
  });

  it('shows a friendly, non-technical message and stops waiting when the request fails', async () => {
    mocked(aiLearningApi.sendTutorMessage).mockResolvedValue({
      id: 'request-2',
      kind: 'tutor',
      status: 'queued',
      request: {},
      result: null,
      error_message: null,
      created_at: '2026-08-16T00:00:00.000Z',
    });
    mocked(aiLearningApi.getLearningRequestById).mockResolvedValue({
      id: 'request-2',
      kind: 'tutor',
      status: 'failed',
      request: {},
      result: null,
      error_message:
        'Avidia could not create that right now. Your stored study tools still work; please try again.',
      created_at: '2026-08-16T00:00:00.000Z',
    });

    await render(<AskAvidiaScreen courseId="course-1" />);
    await waitFor(() => expect(aiLearningApi.listTutorMessages).toHaveBeenCalled());
    await fireEvent.changeText(
      screen.getByPlaceholderText("Ask about your course, a concept, or what you're studying..."),
      'Go deeper.'
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Ask Avidia' }));

    await screen.findByText(
      'Avidia could not create that right now. Your stored study tools still work; please try again.'
    );
    // Never a raw provider/HTTP detail (429/401/5xx, stack traces, etc.).
    expect(screen.queryByText(/\b\d{3}\b/)).toBeNull();
    expect(screen.queryByText('Thinking…')).toBeNull();
  });

  it('disables "Why was I wrong?" when there is no question-review context', async () => {
    await render(<AskAvidiaScreen courseId="course-1" />);
    await waitFor(() => expect(aiLearningApi.listTutorMessages).toHaveBeenCalled());
    const button = screen.getByText('Why was I wrong?');
    await fireEvent.press(button);
    expect(aiLearningApi.sendTutorMessage).not.toHaveBeenCalled();
  });

  it('sends "Why was I wrong?" when question-review context is present', async () => {
    mocked(aiLearningApi.sendTutorMessage).mockResolvedValue({
      id: 'request-3',
      kind: 'tutor',
      status: 'queued',
      request: {},
      result: null,
      error_message: null,
      created_at: '2026-08-16T00:00:00.000Z',
    });
    mocked(aiLearningApi.getLearningRequestById).mockResolvedValue({
      id: 'request-3',
      kind: 'tutor',
      status: 'queued',
      request: {},
      result: null,
      error_message: null,
      created_at: '2026-08-16T00:00:00.000Z',
    });

    await render(<AskAvidiaScreen courseId="course-1" context={{ questionId: 'question-1' }} />);
    await waitFor(() => expect(aiLearningApi.listTutorMessages).toHaveBeenCalled());
    await fireEvent.press(screen.getByText('Why was I wrong?'));
    await waitFor(() => expect(aiLearningApi.sendTutorMessage).toHaveBeenCalled());
    expect(aiLearningApi.sendTutorMessage).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'course-1',
      'conversation-1',
      'Why was I wrong?',
      expect.objectContaining({ questionId: 'question-1' })
    );
  });

    it('auto-sends the deep-linked prompt when autoSend is set, without a second manual tap', async () => {
      mocked(aiLearningApi.sendTutorMessage).mockResolvedValue({
      id: 'request-4',
      kind: 'tutor',
      status: 'queued',
      request: {},
      result: null,
      error_message: null,
      created_at: '2026-08-16T00:00:00.000Z',
    });
    mocked(aiLearningApi.getLearningRequestById).mockResolvedValue({
      id: 'request-4',
      kind: 'tutor',
      status: 'queued',
      request: {},
      result: null,
      error_message: null,
      created_at: '2026-08-16T00:00:00.000Z',
  });

    await render(
      <AskAvidiaScreen
        courseId="course-1"
        context={{ questionId: 'question-1' }}
        initialPrompt="Why was I wrong?"
        autoSend
      />
    );
    await waitFor(() => expect(aiLearningApi.sendTutorMessage).toHaveBeenCalled());
    expect(aiLearningApi.sendTutorMessage).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'course-1',
      'conversation-1',
      'Why was I wrong?',
      expect.objectContaining({ questionId: 'question-1' })
    );
    // Only ever sent once - no double-fire from re-renders.
    expect(aiLearningApi.sendTutorMessage).toHaveBeenCalledTimes(1);
  });

  it('does not auto-send without the autoSend flag, even with a prefilled prompt', async () => {
    await render(
      <AskAvidiaScreen
        courseId="course-1"
        context={{ questionId: 'question-1' }}
        initialPrompt="Why was I wrong?"
      />
    );
    await waitFor(() => expect(aiLearningApi.listTutorMessages).toHaveBeenCalled());
    expect(aiLearningApi.sendTutorMessage).not.toHaveBeenCalled();
  });

  describe('provenance badge (spec: "Retrieved ≠ supporting" — never derived from source count alone)', () => {
    const base = {
      id: 'm-a',
      role: 'assistant' as const,
      content: 'An answer.',
      task: 'RAG_ANSWER',
      model_tier: 'STANDARD',
      created_at: '2026-08-16T00:00:05.000Z',
    };

    it('shows the course-grounded badge only when the mode is actually course_grounded', async () => {
      mocked(aiLearningApi.listTutorMessages).mockResolvedValue([
        { ...base, source_chunk_ids: ['c1'], grounding: 'course_grounded' },
      ]);
      await render(<AskAvidiaScreen courseId="course-1" />);
      await screen.findByText('Grounded in 1 course source.');
    });

    it('never shows "Grounded" when the mode is general_knowledge, even if chunks were retrieved for other bookkeeping', async () => {
      mocked(aiLearningApi.listTutorMessages).mockResolvedValue([
        { ...base, source_chunk_ids: [], grounding: 'general_knowledge' },
      ]);
      await render(<AskAvidiaScreen courseId="course-1" />);
      await screen.findByText(
        'Not grounded in your course material — general nursing/medical knowledge.'
      );
      expect(screen.queryByText(/Grounded in \d+ course source/)).toBeNull();
    });

    it('labels a mixed answer distinctly from fully course-grounded or fully general', async () => {
      mocked(aiLearningApi.listTutorMessages).mockResolvedValue([
        { ...base, source_chunk_ids: ['c1'], grounding: 'mixed' },
      ]);
      await render(<AskAvidiaScreen courseId="course-1" />);
      await screen.findByText(
        'Partly grounded in 1 course source, partly general nursing/medical knowledge.'
      );
    });
  });
});
