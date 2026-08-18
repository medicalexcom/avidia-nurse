import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';

import { useAuth } from '../../auth/AuthProvider';
import { getSupabase } from '../../../lib/supabase';
import { ErrorBanner, PrimaryButton, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import { getSimulationView } from '../../simulation/simulationApi';
import {
  getLearningRequestById,
  getOrCreateConversation,
  listTutorMessages,
  sendTutorMessage,
  type TutorConversation,
  type TutorMessage,
} from '../aiLearningApi';

// Ask Avidia is processed asynchronously by the background worker (spec J).
// Poll for the reply instead of requiring a manual "Refresh answer" tap;
// bounded to stay above the worker's 5-minute cron cadence (.github/workflows/worker.yml) so a request queued right after a run starts doesn't time out before the next run even starts.
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 360000;
const TIMEOUT_MESSAGE =
  'This is taking longer than expected. Avidia is still working on it in the background — tap Refresh answer in a bit.';
const FAILURE_FALLBACK_MESSAGE = "Avidia couldn't generate a response right now. Try again.";

// Unobtrusive per-answer provenance badge. The grounding mode is computed
// deterministically by the worker (never derived from the model's own
// claim, and never merely from "N chunks were retrieved" — that is the bug
// this replaces: a refusal used to still display "Grounded in 8 course
// sources" because retrieval had returned 8 chunks that were never actually
// relevant to the question).
function groundingLabel(m: TutorMessage): string {
  const count = m.source_chunk_ids.length;
  const sourceNoun = `${count} course source${count === 1 ? '' : 's'}`;
  if (m.grounding === 'course_grounded') return `Grounded in ${sourceNoun}.`;
  if (m.grounding === 'mixed')
    return count
      ? `Partly grounded in ${sourceNoun}, partly general nursing/medical knowledge.`
      : 'Partly general nursing/medical knowledge.';
  if (m.grounding === 'general_knowledge')
    return 'Not grounded in your course material — general nursing/medical knowledge.';
  // Rows written before the grounding column existed carry no mode; fall
  // back to the previous (less precise) source-count heuristic rather than
  // showing nothing.
  return count ? `Grounded in ${sourceNoun}.` : '';
}

// A stable reference for the no-context case. `context = {}` as a default
// parameter would create a NEW object every render; since `context` is a
// dependency of `load` below, that new reference retriggered the load
// effect on every render — an unbounded refetch loop whenever no context
// prop was passed (i.e. whenever Ask Avidia was opened outside a
// question-review/simulation deep link). Found while adding UI polling.
const EMPTY_CONTEXT: Record<string, unknown> = {};

export function AskAvidiaScreen({
  courseId,
  context = EMPTY_CONTEXT,
  initialPrompt,
}: {
  courseId: string;
  context?: Record<string, unknown>;
  initialPrompt?: string;
}) {
  const { user } = useAuth();
  const [conversation, setConversation] = useState<TutorConversation | null>(null);
  const [messages, setMessages] = useState<TutorMessage[]>([]);
  const [text, setText] = useState(initialPrompt ?? '');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollToken = useRef(0);
  // Track the resolved conversation outside React state so `load` doesn't
  // need `conversation` as a dependency. Previously it did, which meant
  // every successful load produced a NEW `load` identity, which retriggered
  // the mount effect below, which called load() again — a redundant (and,
  // with an unstable `context` reference, potentially unbounded) refetch
  // loop. Found while adding UI polling for this fix.
  const conversationRef = useRef<TutorConversation | null>(null);
  // Collapse concurrent load() calls into one in-flight run. The mount
  // effect and an explicit call from send()/pollForReply can otherwise fire
  // close enough together (StrictMode's double-invoked effects make this
  // easy to hit even outside a race with send()) to interleave two
  // independent fetch-then-setState sequences, which can commit stale state
  // out of order. Found while adding UI polling for this fix.
  const loadInFlight = useRef<Promise<void> | null>(null);
  const load = useCallback(async () => {
    if (loadInFlight.current) return loadInFlight.current;
    const run = async () => {
      const client = getSupabase();
      if (!client || !user) return;
      try {
        const c =
          conversationRef.current ??
          (await getOrCreateConversation(client, user.id, courseId, context));
        conversationRef.current = c;
        setConversation(c);
        setMessages(await listTutorMessages(client, c.id));
        setError(null);
      } catch {
        setError('Ask Avidia is unavailable right now. Your stored study tools still work.');
      }
    };
    loadInFlight.current = run().finally(() => {
      loadInFlight.current = null;
    });
    return loadInFlight.current;
  }, [context, courseId, user]);
  useEffect(() => {
    load();
  }, [load]);
  const stopPolling = useCallback(() => {
    pollToken.current += 1;
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
    setPending(false);
  }, []);
  useEffect(() => stopPolling, [stopPolling]);
  const pollForReply = useCallback(
    (requestId: string) => {
      const client = getSupabase();
      if (!client) return;
      const token = pollToken.current;
      const startedAt = Date.now();
      const tick = async () => {
        if (token !== pollToken.current) return; // superseded by a newer send() or unmount
        try {
          const request = await getLearningRequestById(client, requestId);
          if (request?.status === 'ready') {
            await load();
            if (token === pollToken.current) setPending(false);
            return;
          }
          if (request?.status === 'failed') {
            if (token === pollToken.current) {
              setError(request.error_message ?? FAILURE_FALLBACK_MESSAGE);
              setPending(false);
            }
            return;
          }
        } catch {
          // Transient read failure — keep polling until the timeout.
        }
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          if (token === pollToken.current) {
            setError(TIMEOUT_MESSAGE);
            setPending(false);
          }
          return;
        }
        pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
      };
      tick();
    },
    [load]
  );
  const send = async (preset?: string) => {
    const content = (preset ?? text).trim();
    const client = getSupabase();
    if (!content || !client || !user || !conversation) return;
    stopPolling();
    setBusy(true);
    setError(null);
    try {
      let requestContext = context;
      if (context.contextType === 'active_simulation' && typeof context.sessionId === 'string') {
        const simulation = await getSimulationView(client, context.sessionId);
        requestContext = { ...context, revealedState: simulation.view };
      }
      const request = await sendTutorMessage(
        client,
        user.id,
        courseId,
        conversation.id,
        content,
        requestContext
      );
      setText('');
      await load();
      setPending(true);
      pollForReply(request.id);
    } catch {
      setError('Avidia could not send that request. Please retry shortly.');
    }
    setBusy(false);
  };
  return (
    <Screen title="Ask Avidia">
      <Text style={styles.intro}>
        Ask about your course, a concept, or what you’re studying. Answers use a bounded
        conversation and relevant course sources.
      </Text>
      <ErrorBanner message={error} />
      <View style={styles.presets}>
        {[
          { label: 'Explain this.' },
          // "Why was I wrong?" needs question-review context (the student's
          // answer, correct answer, and rationale) to produce a useful reply
          // — sending it without that context just wastes a request.
          { label: 'Why was I wrong?', requiresQuestionContext: true },
          { label: 'Simplify.' },
          { label: 'Go deeper.' },
          { label: 'Give me an example.' },
          { label: 'Quiz me.' },
          { label: 'Give me a case.' },
          { label: 'Create a simulation on this.' },
        ].map(({ label, requiresQuestionContext }) => (
          <SecondaryButton
            key={label}
            label={label}
            onPress={() => send(label)}
            disabled={busy || (requiresQuestionContext && typeof context.questionId !== 'string')}
          />
        ))}
      </View>
      {messages.map((m) => (
        <View
          key={m.id}
          style={[styles.message, m.role === 'assistant' ? styles.assistant : styles.user]}
        >
          <Text style={styles.role}>{m.role === 'assistant' ? 'Avidia' : 'You'}</Text>
          <Text style={styles.body}>{m.content}</Text>
          {m.role === 'assistant' ? <Text style={styles.source}>{groundingLabel(m)}</Text> : null}
          {m.task === 'QUESTION_GENERATION_ROUTINE' ? (
            <SecondaryButton
              label="Start a scored adaptive quiz"
              onPress={() => router.push(`/course/${courseId}/practice?mode=adaptive`)}
            />
          ) : null}
        </View>
      ))}
      {pending ? (
        <View style={[styles.message, styles.assistant]}>
          <Text style={styles.role}>Avidia</Text>
          <Text style={styles.body}>Thinking…</Text>
        </View>
      ) : null}
      <TextInput
        accessibilityLabel="Ask Avidia"
        placeholder="Ask about your course, a concept, or what you're studying..."
        multiline
        value={text}
        onChangeText={setText}
        style={styles.input}
      />
      <PrimaryButton label="Ask Avidia" onPress={() => send()} busy={busy} />
      <SecondaryButton label="Refresh answer" onPress={load} />
    </Screen>
  );
}
const styles = StyleSheet.create({
  intro: { color: colors.textMuted, marginBottom: spacing(3) },
  presets: { gap: spacing(2), marginBottom: spacing(3) },
  message: { borderRadius: 10, padding: spacing(3), marginBottom: spacing(2) },
  assistant: { backgroundColor: colors.surface },
  user: { backgroundColor: colors.badge },
  role: { fontWeight: '700', color: colors.text, marginBottom: spacing(1) },
  body: { color: colors.text },
  source: { color: colors.textMuted, fontSize: 12, marginTop: spacing(2) },
  input: {
    minHeight: 96,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: spacing(3),
    marginTop: spacing(3),
    marginBottom: spacing(2),
  },
});
