import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { useAuth } from '../../auth/AuthProvider';
import { getSupabase } from '../../../lib/supabase';
import { ErrorBanner, PrimaryButton, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import {
  getOrCreateConversation,
  listTutorMessages,
  sendTutorMessage,
  type TutorConversation,
  type TutorMessage,
} from '../aiLearningApi';

export function AskAvidiaScreen({
  courseId,
  context = {},
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
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) return;
    try {
      const c = conversation ?? (await getOrCreateConversation(client, user.id, courseId, context));
      setConversation(c);
      setMessages(await listTutorMessages(client, c.id));
      setError(null);
    } catch {
      setError('Ask Avidia is unavailable right now. Your stored study tools still work.');
    }
  }, [conversation, context, courseId, user]);
  useEffect(() => {
    load();
  }, [load]);
  const send = async (preset?: string) => {
    const content = (preset ?? text).trim();
    const client = getSupabase();
    if (!content || !client || !user || !conversation) return;
    setBusy(true);
    try {
      await sendTutorMessage(client, user.id, courseId, conversation.id, content, context);
      setText('');
      await load();
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
          'Explain this.',
          'Why was I wrong?',
          'Simplify.',
          'Go deeper.',
          'Give me an example.',
          'Quiz me.',
          'Give me a case.',
          'Create a simulation on this.',
        ].map((p) => (
          <SecondaryButton key={p} label={p} onPress={() => send(p)} disabled={busy} />
        ))}
      </View>
      {messages.map((m) => (
        <View
          key={m.id}
          style={[styles.message, m.role === 'assistant' ? styles.assistant : styles.user]}
        >
          <Text style={styles.role}>{m.role === 'assistant' ? 'Avidia' : 'You'}</Text>
          <Text style={styles.body}>{m.content}</Text>
          {m.source_chunk_ids.length ? (
            <Text style={styles.source}>
              Grounded in {m.source_chunk_ids.length} course source
              {m.source_chunk_ids.length === 1 ? '' : 's'}.
            </Text>
          ) : null}
        </View>
      ))}
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
