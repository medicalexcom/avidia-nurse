import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { CONCEPT_TYPE_LABELS } from '@avidia/domain';

import { useAuth } from '../../auth/AuthProvider';
import { getSupabase } from '../../../lib/supabase';
import { ErrorBanner, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import { fetchOwnCourse, type Course } from '../../courses/coursesApi';
import { listConcepts, type ConceptListRow } from '../conceptsApi';

/**
 * Course concepts list (M6 spec P). A restrained, honest view: the concepts
 * the platform identified in THIS course's uploaded materials, ordered by
 * course emphasis (a transparent count of supporting material — a
 * study-priority signal, not an exam prediction). This is not the adaptive
 * study interface; it exists so students can verify what was identified and
 * where it came from.
 */

export function ConceptsScreen({ courseId }: { courseId: string }) {
  const { user } = useAuth();
  const [course, setCourse] = useState<Course | null>(null);
  const [concepts, setConcepts] = useState<ConceptListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) {
      setLoading(false);
      return;
    }
    try {
      const [c, list] = await Promise.all([
        fetchOwnCourse(client, user.id, courseId),
        listConcepts(client, courseId),
      ]);
      setCourse(c);
      setConcepts(list);
      setError(c ? null : 'This course could not be found.');
    } catch {
      setError('We could not load the concepts. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [user, courseId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  if (loading) {
    return (
      <Screen title="Concepts">
        <Text style={styles.muted}>Loading concepts…</Text>
      </Screen>
    );
  }
  if (!course) {
    return (
      <Screen title="Concepts">
        <ErrorBanner message={error} />
        <SecondaryButton label="Back to courses" onPress={() => router.replace('/courses')} />
      </Screen>
    );
  }

  return (
    <Screen title={`Concepts — ${course.title}`}>
      <ErrorBanner message={error} />
      {error ? <SecondaryButton label="Retry" onPress={load} /> : null}
      <Text style={styles.intro}>
        Concepts identified in your uploaded materials, ordered by how much of your course covers
        them. Open a concept to see exactly where it appears.
      </Text>
      {concepts.length === 0 ? (
        <Text style={styles.muted}>
          No concepts identified yet. Concepts appear here automatically after your uploaded
          materials finish processing.
        </Text>
      ) : (
        concepts.map((concept) => (
          <Pressable
            key={concept.id}
            accessibilityRole="button"
            accessibilityLabel={`Open concept ${concept.canonical_name}`}
            onPress={() => router.push(`/course/${courseId}/concept/${concept.id}`)}
            style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
          >
            <View style={styles.cardHeader}>
              <Text style={styles.name}>{concept.canonical_name}</Text>
              <Text style={styles.typeBadge}>{CONCEPT_TYPE_LABELS[concept.concept_type]}</Text>
            </View>
            {concept.summary ? <Text style={styles.summary}>{concept.summary}</Text> : null}
            <Text style={styles.meta}>
              Found in {concept.source_count} place{concept.source_count === 1 ? '' : 's'} in your
              materials
            </Text>
          </Pressable>
        ))
      )}
      <SecondaryButton label="Back to course" onPress={() => router.push(`/course/${courseId}`)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted, fontSize: 15, lineHeight: 22 },
  intro: { color: colors.textMuted, fontSize: 14, lineHeight: 20, marginBottom: spacing(3) },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(4),
    gap: spacing(1),
    marginBottom: spacing(3),
  },
  cardPressed: { backgroundColor: colors.background },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing(2),
    flexWrap: 'wrap',
  },
  name: { fontSize: 16, fontWeight: '700', color: colors.text, flexShrink: 1 },
  typeBadge: { fontSize: 13, color: colors.primary, fontWeight: '600' },
  summary: { fontSize: 14, color: colors.text, lineHeight: 20 },
  meta: { fontSize: 13, color: colors.textMuted },
});
