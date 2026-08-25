import { useCallback, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { useAuth } from '../../src/features/auth/AuthProvider';
import { listOwnCourses, type CourseSummary } from '../../src/features/courses/coursesApi';
import { getSupabase } from '../../src/lib/supabase';
import { CourseListRow, ErrorBanner, Screen, SecondaryButton } from '../../src/ui/components';
import { colors, spacing } from '../../src/ui/theme';

/**
 * Study tab (M8 spec AF): a plain chooser that opens the per-course study
 * dashboard. All recommendation logic lives behind that dashboard — this
 * screen only lists courses.
 */
export default function StudyScreen() {
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
    <Screen title="Study" section="study" icon="create-outline">
      <ErrorBanner message={error} />
      {error ? <SecondaryButton label="Retry" onPress={load} /> : null}
      {loading ? (
        <Text style={styles.muted}>Loading your courses…</Text>
      ) : courses.length === 0 ? (
        <>
          <Text style={styles.muted}>
            No courses yet. Create a course and upload materials, then your study plan will appear
            here.
          </Text>
          <SecondaryButton label="Go to courses" onPress={() => router.push('/courses')} />
        </>
      ) : (
        <>
          <Text style={styles.muted}>Pick a course to see your study plan.</Text>
          {courses.map((course) => (
            <CourseListRow
              key={course.id}
              section="study"
              icon="create-outline"
              title={course.title}
              meta={course.term ?? undefined}
              onPress={() => router.push(`/course/${course.id}/study`)}
            />
          ))}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted, marginBottom: spacing(4) },
});
