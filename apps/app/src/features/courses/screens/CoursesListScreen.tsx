import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { examCountdown, nextUpcomingExam } from '@avidia/domain';

import { useAuth } from '../../auth/AuthProvider';
import { getSupabase } from '../../../lib/supabase';
import { useUserTimezone } from '../../profile/useTimezone';
import { ErrorBanner, PrimaryButton, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import { listOwnCourses, type CourseSummary } from '../coursesApi';

const LOAD_ERROR = 'We could not load your courses. Please try again.';

export function CoursesListScreen() {
  const { user } = useAuth();
  const timezone = useUserTimezone();
  const [courses, setCourses] = useState<CourseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) {
      setCourses([]);
      return;
    }
    try {
      setCourses(await listOwnCourses(client, user.id));
      setError(null);
    } catch {
      setError(LOAD_ERROR);
      setCourses((prev) => prev ?? []);
    }
  }, [user]);

  // Reload whenever the screen gains focus (e.g. returning from "new course").
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const loading = courses === null && !error;
  const active = (courses ?? []).filter((c) => c.status === 'active');
  const archived = (courses ?? []).filter((c) => c.status === 'archived');
  const visible = showArchived ? [...active, ...archived] : active;

  return (
    <Screen title="Courses">
      <ErrorBanner message={error} />
      {error ? <SecondaryButton label="Retry" onPress={load} /> : null}

      {loading ? (
        <Text style={styles.muted}>Loading your courses…</Text>
      ) : visible.length === 0 && archived.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No courses yet</Text>
          <Text style={styles.muted}>
            Add the courses you are taking this term to start tracking modules and exam dates.
          </Text>
          <PrimaryButton
            label="Create your first course"
            onPress={() => router.push('/course/new')}
          />
        </View>
      ) : (
        <>
          <PrimaryButton label="Add course" onPress={() => router.push('/course/new')} />
          <View style={styles.list}>
            {visible.map((course) => (
              <CourseCard key={course.id} course={course} timezone={timezone} />
            ))}
          </View>
          {archived.length > 0 ? (
            <SecondaryButton
              label={
                showArchived
                  ? 'Hide archived courses'
                  : `Show archived courses (${archived.length})`
              }
              onPress={() => setShowArchived((v) => !v)}
            />
          ) : null}
        </>
      )}
    </Screen>
  );
}

function CourseCard({ course, timezone }: { course: CourseSummary; timezone: string }) {
  const next = nextUpcomingExam(course.exams, timezone);
  const countdown = next ? examCountdown(next.exam_at, timezone) : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open course ${course.title}`}
      onPress={() => router.push(`/course/${course.id}`)}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{course.title}</Text>
        {course.status === 'archived' ? (
          <View style={styles.archivedBadge}>
            <Text style={styles.archivedBadgeText}>Archived</Text>
          </View>
        ) : null}
      </View>
      {course.term ? <Text style={styles.cardMeta}>{course.term}</Text> : null}
      <Text style={styles.cardMeta}>
        {course.module_count === 1 ? '1 module' : `${course.module_count} modules`}
      </Text>
      {next && countdown ? (
        <Text style={styles.cardCountdown}>
          {next.title}: {countdown.label}
        </Text>
      ) : (
        <Text style={styles.cardMeta}>No upcoming exams</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted, fontSize: 15, lineHeight: 22 },
  empty: { gap: spacing(3), marginTop: spacing(4) },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  list: { gap: spacing(3), marginTop: spacing(4), marginBottom: spacing(4) },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(4),
    gap: spacing(1),
  },
  cardPressed: { backgroundColor: colors.background },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing(2) },
  cardTitle: { fontSize: 17, fontWeight: '700', color: colors.text, flexShrink: 1 },
  cardMeta: { fontSize: 14, color: colors.textMuted },
  cardCountdown: { fontSize: 14, color: colors.primary, fontWeight: '600' },
  archivedBadge: {
    backgroundColor: colors.badge,
    borderRadius: 999,
    paddingHorizontal: spacing(2),
    paddingVertical: spacing(0.5),
  },
  archivedBadgeText: { color: colors.badgeText, fontSize: 11, fontWeight: '600' },
});
