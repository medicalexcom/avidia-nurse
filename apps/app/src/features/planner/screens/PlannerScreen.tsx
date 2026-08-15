import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { examCountdown } from '@avidia/domain';
import {
  buildReminderInstructions,
  createStudyPlan,
  hasNoAvailability,
  localDateKey,
  type StudyPlanResult,
} from '@avidia/planner';

import { getSupabase } from '../../../lib/supabase';
import { ErrorBanner, PrimaryButton, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import { useAuth } from '../../auth/AuthProvider';
import { listOwnCourses, type CourseSummary } from '../../courses/coursesApi';
import { useUserTimezone } from '../../profile/useTimezone';
import { ACTIVITY_TYPE_LABELS, activityLaunchRoute, reasonLine } from '../launch';
import { remindersSupported, syncScheduledReminders } from '../notifications';
import {
  countSimulationCases,
  fetchActivePlan,
  fetchPlannerSettings,
  loadPlannerCourseInput,
  reconcilePlanCompletion,
  saveStudyPlan,
  skipPlannedActivity,
  startPlannedActivity,
  type PlannerSettings,
  type StoredActivityRow,
  type StoredPlan,
} from '../plannerApi';

/**
 * Study Planner screen — M13 (spec V/W/X/P/AQ/AR).
 *
 * Mobile-first Today view with START TODAY'S PLAN, a simple week list below
 * (spec W — no drag-and-drop calendar grids), and exam countdowns in the
 * student's timezone (spec X). Every schedule decision was made by the pure
 * engine at generation time; this screen renders stored rows and forwards
 * taps to existing experiences (spec A/Y). Works fully with AI down: reads
 * and deterministic generation only (spec AQ).
 */

interface ExamBadge {
  examId: string;
  title: string;
  courseTitle: string;
  label: string;
}

function weekdayLabel(dateKey: string): string {
  const parsed = new Date(`${dateKey}T12:00:00Z`);
  return parsed.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function PlannerScreen() {
  const { user } = useAuth();
  const timeZone = useUserTimezone();
  const [stored, setStored] = useState<StoredPlan | null>(null);
  const [settings, setSettings] = useState<PlannerSettings | null>(null);
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) {
      setLoading(false);
      return;
    }
    try {
      const [owned, loadedSettings, active] = await Promise.all([
        listOwnCourses(client, user.id),
        fetchPlannerSettings(client, user.id),
        fetchActivePlan(client, user.id),
      ]);
      setCourses(owned.filter((course) => course.status === 'active'));
      setSettings(loadedSettings);
      if (active) {
        // Spec U/Z: reconcile ACTUAL completed sessions before rendering, so
        // finished work shows as done without any screen-open guessing.
        const newlyCompleted = await reconcilePlanCompletion(client, active).catch(() => 0);
        setStored(newlyCompleted > 0 ? await fetchActivePlan(client, user.id) : active);
      } else {
        setStored(null);
      }
      setError(null);
    } catch {
      setError('We could not load your plan. Please try again.');
    }
    setLoading(false);
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const regenerate = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user || !settings) return;
    setGenerating(true);
    try {
      const active = courses.length
        ? courses
        : (await listOwnCourses(client, user.id)).filter((c) => c.status === 'active');
      const now = new Date();
      const simulationCases = await countSimulationCases(client);
      const inputs = await Promise.all(
        active.map((course) =>
          loadPlannerCourseInput(client, course, timeZone, now, simulationCases)
        )
      );
      const result: StudyPlanResult = createStudyPlan({
        courses: inputs,
        availability: settings.availability,
        timeZone,
        now,
      });
      await saveStudyPlan(client, result, timeZone);
      const refreshed = await fetchActivePlan(client, user.id);
      setStored(refreshed);
      setError(null);
      // Spec S/AA: reschedule local reminders from the NEW plan (no-op on web
      // or when permission was never granted).
      if (remindersSupported()) {
        const exams = active.flatMap((course) =>
          course.exams.map((exam) => ({
            examId: exam.id,
            courseId: course.id,
            title: exam.title,
            examAt: exam.exam_at,
          }))
        );
        await syncScheduledReminders(
          buildReminderInstructions({
            prefs: settings.reminders,
            plan: result,
            exams,
            timeZone,
            now,
          })
        ).catch(() => 0);
      }
    } catch {
      setError('We could not build your plan. Please try again.');
    }
    setGenerating(false);
  }, [user, settings, courses, timeZone]);

  const launch = useCallback(async (activity: StoredActivityRow) => {
    const client = getSupabase();
    if (client && activity.status === 'planned') {
      await startPlannedActivity(client, activity.id).catch(() => {});
    }
    router.push(
      activityLaunchRoute({
        courseId: activity.course_id,
        type: activity.activity_type,
        modeId: activity.mode_id,
        minutes: activity.minutes,
      })
    );
  }, []);

  const skip = useCallback(async (activity: StoredActivityRow) => {
    const client = getSupabase();
    if (!client) return;
    await skipPlannedActivity(client, activity.id).catch(() => {});
    setStored((current) =>
      current
        ? {
            ...current,
            activities: current.activities.map((row) =>
              row.id === activity.id ? { ...row, status: 'skipped' } : row
            ),
          }
        : current
    );
  }, []);

  if (loading) {
    return (
      <Screen title="Planner">
        <Text style={styles.muted}>Loading your plan…</Text>
      </Screen>
    );
  }

  // Spec AR: no courses yet — gentle onboarding, never a dead end.
  if (courses.length === 0) {
    return (
      <Screen title="Planner">
        <Text style={styles.emptyHeading}>Your plan starts with a course.</Text>
        <Text style={styles.muted}>
          Create a course and add material, and Avidia will plan your study days around your exams
          and available time.
        </Text>
        <PrimaryButton label="Create a course" onPress={() => router.push('/courses')} />
      </Screen>
    );
  }

  const courseTitles = new Map(courses.map((course) => [course.id, course.title]));
  const now = new Date();
  const examBadges: ExamBadge[] = courses
    .flatMap((course) =>
      course.exams.map((exam) => ({
        examId: exam.id,
        title: exam.title,
        courseTitle: course.title,
        countdown: examCountdown(exam.exam_at, timeZone, now),
        examAt: exam.exam_at,
      }))
    )
    .filter((entry) => entry.countdown.kind !== 'completed' && entry.countdown.kind !== 'invalid')
    .sort((a, b) => Date.parse(a.examAt) - Date.parse(b.examAt))
    .slice(0, 4)
    .map((entry) => ({
      examId: entry.examId,
      title: entry.title,
      courseTitle: entry.courseTitle,
      label: entry.countdown.label,
    }));

  const todayKey = localDateKey(now, timeZone);
  const byDate = new Map<string, StoredActivityRow[]>();
  for (const activity of stored?.activities ?? []) {
    if (activity.status === 'superseded' || activity.status === 'expired') continue;
    const list = byDate.get(activity.activity_date) ?? [];
    list.push(activity);
    byDate.set(activity.activity_date, list);
  }
  const todayActivities = byDate.get(todayKey) ?? [];
  const todayPending = todayActivities.filter(
    (activity) => activity.status === 'planned' || activity.status === 'started'
  );
  const upcomingDates = [...byDate.keys()].filter((date) => date > todayKey).sort();
  const noAvailability = settings ? hasNoAvailability(settings.availability) : false;

  const renderActivity = (activity: StoredActivityRow, actionable: boolean) => {
    const done = activity.status === 'completed';
    const skipped = activity.status === 'skipped';
    return (
      <View key={activity.id} style={styles.activityRow}>
        <View style={styles.activityText}>
          <Text style={[styles.activityTitle, (done || skipped) && styles.activityDone]}>
            {done ? '✓ ' : ''}
            {ACTIVITY_TYPE_LABELS[activity.activity_type]}
            {activity.concept_id && activity.reasons.length > 0 ? '' : ''}
          </Text>
          <Text style={styles.activityMeta}>
            {courseTitles.get(activity.course_id) ?? 'Course'} · {activity.minutes} min
            {reasonLine(activity.reasons) ? ` · ${reasonLine(activity.reasons)}` : ''}
            {skipped ? ' · skipped' : ''}
          </Text>
        </View>
        {actionable && !done && !skipped ? (
          <View style={styles.activityActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Start ${ACTIVITY_TYPE_LABELS[activity.activity_type]}`}
              onPress={() => launch(activity)}
              style={styles.startChip}
            >
              <Text style={styles.startChipText}>
                {activity.status === 'started' ? 'Resume' : 'Start'}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Skip ${ACTIVITY_TYPE_LABELS[activity.activity_type]}`}
              onPress={() => skip(activity)}
              style={styles.skipChip}
            >
              <Text style={styles.skipChipText}>Skip</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <Screen title="Planner">
      <ErrorBanner message={error} />

      {examBadges.length > 0 ? (
        <View style={styles.card}>
          {examBadges.map((badge) => (
            <View key={badge.examId} style={styles.examRow}>
              <Text style={styles.examTitle}>
                {badge.title} · {badge.courseTitle}
              </Text>
              <Text style={styles.examCountdown}>{badge.label}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {noAvailability ? (
        // Spec C/AR: zero availability is a valid preference, stated plainly.
        <View style={styles.card}>
          <Text style={styles.cardHeading}>No study time set</Text>
          <Text style={styles.muted}>
            Your availability is set to zero minutes every day. Add some time and Avidia will plan
            around it.
          </Text>
          <PrimaryButton
            label="Set availability"
            onPress={() => router.push('/planner-settings')}
          />
        </View>
      ) : null}

      {stored ? (
        <>
          <View style={styles.todayCard}>
            <Text style={styles.todayHeading}>Today</Text>
            {todayActivities.length === 0 ? (
              <Text style={styles.muted}>
                Nothing scheduled today. Rest counts too — your plan resumes on the next study day.
              </Text>
            ) : (
              <>
                {todayActivities.map((activity) => renderActivity(activity, true))}
                {todayPending.length > 0 && todayPending[0] ? (
                  <PrimaryButton
                    label="START TODAY'S PLAN"
                    onPress={() => launch(todayPending[0]!)}
                  />
                ) : (
                  <Text style={styles.doneLine}>Today&apos;s plan is done. Nice work.</Text>
                )}
              </>
            )}
          </View>

          {stored.plan.over_capacity ? (
            // Spec P: honest constraint — never silently drop work.
            <View style={styles.capacityCard}>
              <Text style={styles.capacityText}>
                There is more recommended work than your available time before your next exam. Your
                plan focuses on the highest-impact items first; adding minutes in settings fits in
                more.
              </Text>
            </View>
          ) : null}

          {upcomingDates.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardHeading}>This week</Text>
              {upcomingDates.slice(0, 6).map((date) => {
                const activities = byDate.get(date) ?? [];
                return (
                  <View key={date} style={styles.weekDay}>
                    <Text style={styles.weekDayLabel}>{weekdayLabel(date)}</Text>
                    {activities.map((activity) => renderActivity(activity, false))}
                  </View>
                );
              })}
            </View>
          ) : null}
        </>
      ) : (
        <View style={styles.card}>
          <Text style={styles.cardHeading}>No plan yet</Text>
          <Text style={styles.muted}>
            Avidia builds a day-by-day plan from your exams, your available time, and what needs
            attention most — using only your own study evidence.
          </Text>
        </View>
      )}

      <View style={styles.footer}>
        <PrimaryButton
          label={generating ? 'Building your plan…' : stored ? 'Refresh plan' : 'Build my plan'}
          onPress={regenerate}
          disabled={generating}
        />
        <SecondaryButton
          label="Availability & reminders"
          onPress={() => router.push('/planner-settings')}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted, marginBottom: spacing(3) },
  emptyHeading: { color: colors.text, fontSize: 18, fontWeight: '600', marginBottom: spacing(2) },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(4),
  },
  cardHeading: { color: colors.text, fontWeight: '600', fontSize: 16, marginBottom: spacing(2) },
  examRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing(1),
    flexWrap: 'wrap',
  },
  examTitle: { color: colors.text, fontWeight: '600', flexShrink: 1 },
  examCountdown: { color: colors.primary, fontWeight: '600' },
  todayCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(4),
  },
  todayHeading: { color: colors.text, fontWeight: '700', fontSize: 20, marginBottom: spacing(2) },
  doneLine: { color: colors.primary, fontWeight: '600', marginTop: spacing(2) },
  capacityCard: {
    backgroundColor: colors.badge,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(4),
  },
  capacityText: { color: colors.text },
  weekDay: { marginBottom: spacing(3) },
  weekDayLabel: { color: colors.textMuted, fontWeight: '600', marginBottom: spacing(1) },
  activityRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing(2),
    gap: spacing(2),
  },
  activityText: { flexShrink: 1 },
  activityTitle: { color: colors.text, fontWeight: '600' },
  activityDone: { color: colors.textMuted },
  activityMeta: { color: colors.textMuted, fontSize: 13 },
  activityActions: { flexDirection: 'row', gap: spacing(2) },
  startChip: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: spacing(2),
    paddingHorizontal: spacing(3),
    minHeight: 44,
    justifyContent: 'center',
  },
  startChipText: { color: '#ffffff', fontWeight: '600' },
  skipChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: spacing(2),
    paddingHorizontal: spacing(3),
    minHeight: 44,
    justifyContent: 'center',
  },
  skipChipText: { color: colors.textMuted },
  footer: { marginTop: spacing(2), gap: spacing(2) },
});
