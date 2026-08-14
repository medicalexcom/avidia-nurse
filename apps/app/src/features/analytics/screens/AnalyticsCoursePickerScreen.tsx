import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { useAuth } from '../../auth/AuthProvider';
import { listOwnCourses, type CourseSummary } from '../../courses/coursesApi';
import { getSupabase } from '../../../lib/supabase';
import { ErrorBanner, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';

/**
 * Shared chooser behind the "Progress" and "Weaknesses" tabs — M12 (spec
 * AG). Both tabs land on the same per-course analytics page (weaknesses are
 * its "Needs attention" section); analytics is always per-course, so these
 * top-level tabs only pick the course. Mirrors the M8 Study chooser exactly.
 */
export function AnalyticsCoursePickerScreen({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  const { user } = useAuth();
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) {
      setLoading(false);
      return;
    }
    try {
      setCourses(await listOwnCourses(client, user.id));
      setError(null);
    } catch {
      setError('We could not load your courses. Please try again.');
    }
    setLoading(false);
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  return (
    <Screen title={title}>
      <ErrorBanner message={error} />
      {error ? <SecondaryButton label="Retry" onPress={load} /> : null}
      {loading ? (
        <Text style={styles.muted}>Loading your courses…</Text>
      ) : courses.length === 0 ? (
        <>
          <Text style={styles.muted}>
            No courses yet. Create a course and start practicing, then your analytics will appear
            here.
          </Text>
          <SecondaryButton label="Go to courses" onPress={() => router.push('/courses')} />
        </>
      ) : (
        <>
          <Text style={styles.muted}>{description}</Text>
          {courses.map((course) => (
            <Pressable
              key={course.id}
              accessibilityRole="button"
              onPress={() => router.push(`/course/${course.id}/analytics`)}
              style={styles.courseRow}
            >
              <Text style={styles.courseTitle}>{course.title}</Text>
              {course.term ? <Text style={styles.courseMeta}>{course.term}</Text> : null}
            </Pressable>
          ))}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted, marginBottom: spacing(4) },
  courseRow: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(2),
  },
  courseTitle: { color: colors.text, fontWeight: '600', fontSize: 16 },
  courseMeta: { color: colors.textMuted, marginTop: spacing(1), fontSize: 13 },
});
