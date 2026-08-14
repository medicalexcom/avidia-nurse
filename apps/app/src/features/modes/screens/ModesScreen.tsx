import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { useAuth } from '../../auth/AuthProvider';
import { getSupabase } from '../../../lib/supabase';
import { ErrorBanner, PrimaryButton, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import { fetchOwnCourse, type Course } from '../../courses/coursesApi';
import { listConcepts } from '../../concepts/conceptsApi';
import { listActiveQuestions } from '../../practice/practiceApi';
import { modeAvailability, type ModeAvailability } from '../registry';

/**
 * Study modes — M10 (spec B/S/T/U).
 *
 * A manual mode picker: every mode is listed with its honest availability
 * for THIS course (spec S), and locked modes explain exactly what unlocks
 * them (spec T) — never a dead end, never a hidden feature. All counts come
 * from the same validated bank practice uses; this screen contains no
 * selection or ranking logic of its own (spec B — that lives in the pure
 * registry).
 */
export function ModesScreen({ courseId }: { courseId: string }) {
  const { user } = useAuth();
  const [course, setCourse] = useState<Course | null>(null);
  const [availability, setAvailability] = useState<ModeAvailability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) {
      setLoading(false);
      return;
    }
    try {
      const [c, questions, concepts] = await Promise.all([
        fetchOwnCourse(client, user.id, courseId),
        listActiveQuestions(client, courseId),
        listConcepts(client, courseId),
      ]);
      setCourse(c);
      setError(c ? null : 'This course could not be found.');
      setAvailability(
        modeAvailability(
          questions.map((question) => ({
            id: question.id,
            conceptId: question.concept_id,
            questionType: question.question_type,
            difficulty: question.difficulty,
            cognitiveLevel: question.cognitive_level,
            priorityFrameworks: question.priority_frameworks,
          })),
          new Map(concepts.map((concept) => [concept.id, concept.concept_type]))
        )
      );
    } catch {
      setError('We could not load study modes. Please try again.');
    }
    setLoading(false);
  }, [user, courseId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  if (loading) {
    return (
      <Screen title="Study modes">
        <Text style={styles.muted}>Loading study modes…</Text>
      </Screen>
    );
  }

  if (!course || !availability) {
    return (
      <Screen title="Study modes">
        <ErrorBanner message={error} />
        <SecondaryButton label="Retry" onPress={load} />
        <SecondaryButton label="Back to courses" onPress={() => router.replace('/courses')} />
      </Screen>
    );
  }

  return (
    <Screen title={`Study modes — ${course.title}`}>
      <ErrorBanner message={error} />
      <Text style={styles.intro}>
        Different drills for different nursing skills — all built from your own course materials,
        and every answer counts toward the same mastery picture.
      </Text>
      {availability.map(({ mode, availableCount, eligible }) => (
        <View key={mode.id} style={styles.card}>
          <Text style={styles.title}>{mode.title}</Text>
          <Text style={styles.tagline}>{mode.tagline}</Text>
          {eligible ? (
            <>
              <Text style={styles.meta}>
                {availableCount} question{availableCount === 1 ? '' : 's'} available
              </Text>
              <PrimaryButton
                label={`Start ${mode.title}`}
                onPress={() => router.push(`/course/${courseId}/practice?mode=${mode.id}`)}
              />
            </>
          ) : (
            <Text style={styles.locked}>{mode.lockedMessage}</Text>
          )}
        </View>
      ))}
      <SecondaryButton label="Back to Today" onPress={() => router.push('/home')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted },
  intro: { color: colors.textMuted, marginBottom: spacing(3) },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    gap: spacing(2),
    marginBottom: spacing(3),
    padding: spacing(3),
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '600' },
  tagline: { color: colors.textMuted, fontSize: 14 },
  meta: { color: colors.textMuted, fontSize: 13 },
  locked: { color: colors.textMuted, fontSize: 13, fontStyle: 'italic' },
});
