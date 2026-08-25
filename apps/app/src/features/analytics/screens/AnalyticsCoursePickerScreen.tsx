import { useCallback, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import type { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../auth/AuthProvider';
import { listOwnCourses, type CourseSummary } from '../../courses/coursesApi';
import { getSupabase } from '../../../lib/supabase';
import { CourseListRow, ErrorBanner, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing, type SectionKey } from '../../../ui/theme';

/**
 * Shared chooser behind the "Progress" and "Weaknesses" tabs — M12 (spec
 * AG). Both tabs land on the same per-course analytics page (weaknesses are
 * its "Needs attention" section); analytics is always per-course, so these
 * top-level tabs only pick the course. Mirrors the M8 Study chooser exactly.
 *
 * `section`/`icon` give the two tabs distinct visual identities even though
 * they share this one implementation.
 */
export function AnalyticsCoursePickerScreen({
  title,
  description,
  section,
  icon,
}: {
  title: string;
  description: string;
  section: SectionKey;
  icon: keyof typeof Ionicons.glyphMap;
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
    <Screen title={title} section={section} icon={icon}>
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
            <CourseListRow
              key={course.id}
              section={section}
              icon={icon}
              title={course.title}
              meta={course.term ?? undefined}
              onPress={() => router.push(`/course/${course.id}/analytics`)}
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
