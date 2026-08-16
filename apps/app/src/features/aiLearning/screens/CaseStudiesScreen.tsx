import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { useAuth } from '../../auth/AuthProvider';
import { getSupabase } from '../../../lib/supabase';
import { ErrorBanner, PrimaryButton, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import {
  listLearningRequests,
  requestLearningArtifact,
  type LearningRequest,
} from '../aiLearningApi';

const MODES = [
  ['recommended', 'Recommended for Me'],
  ['upcoming_exam', 'Upcoming Exam'],
  ['weakest', 'My Weakest Area'],
  ['topic', 'Choose Topic'],
  ['surprise', 'Surprise Me'],
] as const;

export function CaseStudiesScreen({ courseId }: { courseId: string }) {
  const { user } = useAuth();
  const [rows, setRows] = useState<LearningRequest[]>([]);
  const [topic, setTopic] = useState('');
  const [difficulty, setDifficulty] = useState('application');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client) return;
    try {
      setRows(await listLearningRequests(client, courseId, 'case_study'));
      setError(null);
    } catch {
      setError('We could not load your case studies. Please try again.');
    }
  }, [courseId]);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const generate = async (mode: string, like?: LearningRequest) => {
    const client = getSupabase();
    if (!client || !user) return;
    setBusy(mode);
    setError(null);
    try {
      await requestLearningArtifact(client, user.id, courseId, 'case_study', {
        mode: like ? 'another' : mode,
        topic: like ? like.result?.title : topic,
        difficulty,
        previousArtifactId: like?.result?.id,
        nonce: mode === 'surprise' || like ? new Date().toISOString() : undefined,
      });
      await load();
    } catch {
      setError('Avidia could not queue that case. Your stored study tools still work.');
    }
    setBusy(null);
  };

  return (
    <Screen title="Case Studies">
      <Text style={styles.intro}>
        Create a private, course-grounded ABSN case from your uploaded material and learning
        priorities.
      </Text>
      <ErrorBanner message={error} />
      <TextInput
        accessibilityLabel="Case topic"
        placeholder="Optional topic"
        value={topic}
        onChangeText={setTopic}
        style={styles.input}
      />
      <View style={styles.row}>
        {['foundational', 'application', 'advanced', 'complex'].map((d) => (
          <SecondaryButton
            key={d}
            label={d === difficulty ? `✓ ${d}` : d}
            onPress={() => setDifficulty(d)}
          />
        ))}
      </View>
      {MODES.map(([mode, label]) => (
        <SecondaryButton
          key={mode}
          label={label}
          onPress={() => generate(mode)}
          disabled={busy !== null}
        />
      ))}
      <SecondaryButton label="Refresh generated cases" onPress={load} />
      {rows.map((row) => (
        <View key={row.id} style={styles.card}>
          <Text style={styles.title}>{String(row.result?.title ?? 'Generating case…')}</Text>
          <Text style={styles.meta}>
            {row.status.replace('_', ' ')} · {String(row.request.difficulty ?? 'application')}
          </Text>
          {row.error_message ? <Text style={styles.error}>{row.error_message}</Text> : null}
          {row.status === 'ready' ? (
            <>
              <CaseStudyContent content={row.result?.content} />
              <PrimaryButton
                label="Another Case Like This"
                onPress={() => generate('another', row)}
              />
            </>
          ) : null}
        </View>
      ))}
      <SecondaryButton
        label="Ask Avidia about this course"
        onPress={() => router.push(`/course/${courseId}/ask-avidia`)}
      />
    </Screen>
  );
}

interface RenderQuestion {
  stem: string;
  options: string[];
  correctOptionIndexes: number[];
  rationale: string;
}
interface RenderPhase {
  title: string;
  update: string;
  questions: RenderQuestion[];
}
interface RenderCase {
  presentation?: string;
  phases?: RenderPhase[];
}

function CaseStudyContent({ content }: { content: unknown }) {
  const value = (content ?? {}) as RenderCase;
  const [answers, setAnswers] = useState<Record<string, number>>({});
  return (
    <View style={styles.caseBody}>
      <Text style={styles.body}>{value.presentation ?? 'Course-grounded case ready.'}</Text>
      {(value.phases ?? []).map((phase, phaseIndex) => (
        <View key={`${phase.title}-${phaseIndex}`} style={styles.phase}>
          <Text style={styles.title}>{phase.title}</Text>
          <Text style={styles.body}>{phase.update}</Text>
          {phase.questions.map((question, questionIndex) => {
            const key = `${phaseIndex}-${questionIndex}`;
            const selected = answers[key];
            const correct =
              selected !== undefined && question.correctOptionIndexes.includes(selected);
            return (
              <View key={key} style={styles.question}>
                <Text style={styles.body}>{question.stem}</Text>
                {question.options.map((option, optionIndex) => (
                  <Pressable
                    accessibilityRole="button"
                    key={`${option}-${optionIndex}`}
                    style={styles.option}
                    onPress={() => setAnswers((current) => ({ ...current, [key]: optionIndex }))}
                  >
                    <Text style={styles.body}>
                      {String.fromCharCode(65 + optionIndex)}. {option}
                    </Text>
                  </Pressable>
                ))}
                {selected !== undefined ? (
                  <Text style={correct ? styles.correct : styles.error}>
                    {correct ? 'Correct. ' : 'Review this choice. '}
                    {question.rationale}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  intro: { color: colors.textMuted, marginBottom: spacing(3) },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing(3),
    marginBottom: spacing(3),
  },
  row: { gap: spacing(2), marginBottom: spacing(3) },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: spacing(3),
    marginTop: spacing(3),
    gap: spacing(2),
  },
  title: { fontWeight: '700', fontSize: 17, color: colors.text },
  meta: { color: colors.textMuted },
  body: { color: colors.text },
  error: { color: colors.danger },
  correct: { color: colors.primaryDark },
  caseBody: { gap: spacing(3) },
  phase: {
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingTop: spacing(3),
    gap: spacing(2),
  },
  question: { gap: spacing(2), marginTop: spacing(2) },
  option: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing(2),
  },
});