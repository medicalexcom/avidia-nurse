import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import {
  MASTERY_STATE_LABELS,
  RECOMMENDATION_REASON_LABELS,
  examCountdown,
  nextUpcomingExam,
} from '@avidia/domain';
import { rankConcepts, type StudyRecommendation } from '@avidia/mastery';

import { trackEvent } from '../../../lib/analytics';
import { getSupabase } from '../../../lib/supabase';
import { ErrorBanner, PrimaryButton, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import { useAuth } from '../../auth/AuthProvider';
import { listConcepts } from '../../concepts/conceptsApi';
import { listOwnCourses, type CourseSummary } from '../../courses/coursesApi';
import {
  findResumableSession,
  listActiveQuestions,
  type StudySessionRow,
} from '../../practice/practiceApi';
import { useUserTimezone } from '../../profile/useTimezone';
import {
  buildConceptSnapshots,
  listConceptMastery,
  listCourseAttempts,
  listCourseExams,
  toUpcomingExams,
  type CourseExamRow,
} from '../../study/studyApi';
import { SESSION_DURATION_MINUTES, dueReviewConceptIds } from '../plan';
import {
  listOwnAttemptTimes,
  listRecentSessions,
  pickDefaultCourseId,
  type RecentSessionRow,
} from '../todayApi';
import { computeStudyStreak, streakLine, type StudyStreak } from '../../modes/streak';

/**
 * Today / Home screen — M9 (spec A/B/P/R/AC/AD/AE).
 *
 * Action, not analytics (spec A): one glance answers "what should I do right
 * now?" and the central CTA is START TODAY (spec AE — deliberately NOT an AI
 * chat box). Priorities and due counts come from the pure @avidia/mastery
 * ranking over the student's own rows; this screen never calculates them
 * (spec C). Counts only — no percentages, scores, or predictions.
 */

interface CourseData {
  questionCount: number;
  attemptCount: number;
  exams: CourseExamRow[];
  ranked: StudyRecommendation[];
  conceptNames: Map<string, string>;
  dueReviewCount: number;
  recent: RecentSessionRow[];
  resumable: StudySessionRow | null;
}

function sessionDateLabel(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function TodayScreen() {
  const { user } = useAuth();
  const timeZone = useUserTimezone();
  const [courses, setCourses] = useState<CourseSummary[] | null>(null);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [data, setData] = useState<CourseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // M10 streak (ADR-0027): a pure derivation over the student's own attempt
  // timestamps — displayed quietly, never stored, never punitive.
  const [streak, setStreak] = useState<StudyStreak | null>(null);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) {
      setLoading(false);
      return;
    }
    try {
      const owned = await listOwnCourses(client, user.id);
      setCourses(owned);
      try {
        const attemptTimes = await listOwnAttemptTimes(client);
        setStreak(computeStudyStreak(attemptTimes, timeZone, new Date()));
      } catch {
        // Best-effort: the streak line simply stays hidden.
        setStreak(null);
      }
      const courseId =
        selectedCourseId && owned.some((c) => c.id === selectedCourseId)
          ? selectedCourseId
          : pickDefaultCourseId(owned, new Date());
      setSelectedCourseId(courseId);
      if (!courseId) {
        setData(null);
        setError(null);
        setLoading(false);
        return;
      }
      const [concepts, questions, mastery, attempts, exams, recent, resumable] = await Promise.all([
        listConcepts(client, courseId),
        listActiveQuestions(client, courseId),
        listConceptMastery(client, courseId),
        listCourseAttempts(client, courseId),
        listCourseExams(client, courseId),
        listRecentSessions(client, courseId),
        findResumableSession(client, courseId),
      ]);
      const now = new Date();
      const snapshots = buildConceptSnapshots(concepts, questions, mastery, attempts);
      const ranked = rankConcepts({
        concepts: snapshots,
        exams: toUpcomingExams(exams),
        timeZone,
        now,
      });
      setData({
        questionCount: questions.length,
        attemptCount: attempts.length,
        exams,
        ranked,
        conceptNames: new Map(concepts.map((c) => [c.id, c.canonical_name])),
        dueReviewCount: dueReviewConceptIds(mastery, now).size,
        recent,
        resumable,
      });
      setError(null);
    } catch {
      // Spec W: the screen stays useful — study can still be launched below.
      setError('We could not load everything for today. Pull back later or try again.');
    }
    setLoading(false);
  }, [user, selectedCourseId, timeZone]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const startSession = (minutes: number) => {
    if (!selectedCourseId) return;
    if (minutes <= 10) trackEvent({ name: 'quick_session_started', requestedMinutes: minutes });
    router.push(`/course/${selectedCourseId}/practice?mode=adaptive&minutes=${minutes}`);
  };

  if (loading) {
    return (
      <Screen title="Today">
        <Text style={styles.muted}>Preparing your day…</Text>
      </Screen>
    );
  }

  // Spec AD: no course yet — guide the first action.
  if (!courses || courses.length === 0) {
    return (
      <Screen title="Today">
        <Text style={styles.emptyHeading}>Welcome{user?.email ? `, ${user.email}` : ''}.</Text>
        <Text style={styles.muted}>
          Create your first course to start studying. Add your syllabus and materials, and Avidia
          builds your daily plan from them.
        </Text>
        <PrimaryButton label="Create your first course" onPress={() => router.push('/courses')} />
      </Screen>
    );
  }

  const selected = courses.find((c) => c.id === selectedCourseId) ?? null;
  const upcoming = data ? nextUpcomingExam(data.exams, timeZone) : null;
  const countdown = upcoming ? examCountdown(upcoming.exam_at, timeZone) : null;
  const topPriorities = data ? data.ranked.slice(0, 3) : [];

  return (
    <Screen title="Today">
      <ErrorBanner message={error} />

      {courses.length > 1 ? (
        <View style={styles.courseChips}>
          {courses.map((course) => (
            <Pressable
              key={course.id}
              accessibilityRole="button"
              accessibilityLabel={`Switch to ${course.title}`}
              accessibilityState={{ selected: course.id === selectedCourseId }}
              onPress={() => {
                setSelectedCourseId(course.id);
                setLoading(true);
              }}
              style={[styles.chip, course.id === selectedCourseId && styles.chipSelected]}
            >
              <Text
                style={course.id === selectedCourseId ? styles.chipTextSelected : styles.chipText}
              >
                {course.title}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <Text style={styles.courseName}>{selected?.title}</Text>
      )}

      {upcoming && countdown ? (
        <View style={styles.examCard}>
          <Text style={styles.examTitle}>{upcoming.title}</Text>
          <Text style={styles.examCountdown}>{countdown.label}</Text>
        </View>
      ) : null}

      {data && data.questionCount === 0 ? (
        // Spec AD: course exists but no validated questions yet.
        <View style={styles.card}>
          <Text style={styles.cardHeading}>Add material to unlock daily study</Text>
          <Text style={styles.muted}>
            Upload lectures or notes and Avidia will turn them into practice questions for your
            daily sessions.
          </Text>
          <PrimaryButton
            label="Upload course material"
            onPress={() => router.push(`/course/${selectedCourseId}/add-material`)}
          />
        </View>
      ) : (
        <>
          {data?.resumable ? (
            <View style={styles.card}>
              <Text style={styles.cardHeading}>You have a session in progress</Text>
              <Text style={styles.muted}>Pick up right where you left off — nothing is lost.</Text>
              <PrimaryButton
                label="Continue your session"
                onPress={() =>
                  router.push(`/course/${selectedCourseId}/practice?mode=adaptive&resume=1`)
                }
              />
            </View>
          ) : null}

          <View style={styles.startCard}>
            <Text style={styles.startHeading}>Start today</Text>
            <Text style={styles.muted}>
              {data && data.attemptCount === 0
                ? 'Your first session doubles as a quick check of where you stand.'
                : 'How much time do you have?'}
            </Text>
            <View style={styles.durationRow}>
              {SESSION_DURATION_MINUTES.map((minutes) => (
                <Pressable
                  key={minutes}
                  accessibilityRole="button"
                  accessibilityLabel={`Start a ${minutes} minute session`}
                  onPress={() => startSession(minutes)}
                  style={styles.durationChip}
                >
                  <Text style={styles.durationText}>{minutes} min</Text>
                </Pressable>
              ))}
            </View>
          </View>

          {data && data.dueReviewCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${data.dueReviewCount} concepts due for review. Start a review session.`}
              onPress={() => startSession(10)}
              style={styles.dueRow}
            >
              <Text style={styles.dueText}>
                Due for review: {data.dueReviewCount}{' '}
                {data.dueReviewCount === 1 ? 'concept' : 'concepts'}
              </Text>
              <Text style={styles.dueAction}>Review now</Text>
            </Pressable>
          ) : null}

          {topPriorities.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardHeading}>Today&apos;s priorities</Text>
              {topPriorities.map((rec) => (
                <View key={rec.conceptId} style={styles.priorityRow}>
                  <Text style={styles.priorityName}>
                    {data?.conceptNames.get(rec.conceptId) ?? 'Course material'}
                  </Text>
                  <Text style={styles.priorityMeta}>
                    {MASTERY_STATE_LABELS[rec.masteryState]}
                    {rec.reasonCodes[0]
                      ? ` — ${RECOMMENDATION_REASON_LABELS[rec.reasonCodes[0]]}`
                      : ''}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          {data && data.recent.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardHeading}>Recent sessions</Text>
              {data.recent.map((session) => (
                <Text key={session.id} style={styles.recentRow}>
                  {sessionDateLabel(session.started_at)} — {session.attempt_count}{' '}
                  {session.attempt_count === 1 ? 'question' : 'questions'}
                  {session.status === 'in_progress' ? ' (in progress)' : ''}
                </Text>
              ))}
            </View>
          ) : null}
        </>
      )}

      {streak && streakLine(streak) ? (
        <Text style={styles.streakLine}>{streakLine(streak)}</Text>
      ) : null}

      {/* M13 spec V: one tap from Today into the day-by-day study plan. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open your study plan"
        onPress={() => router.push('/planner')}
        style={styles.plannerRow}
      >
        <Text style={styles.dueText}>Your study plan</Text>
        <Text style={styles.dueAction}>Open planner</Text>
      </Pressable>

      <View style={styles.footer}>
        <SecondaryButton
          label="Open course"
          onPress={() => router.push(`/course/${selectedCourseId}`)}
        />
        <SecondaryButton
          label="Study modes"
          onPress={() => router.push(`/course/${selectedCourseId}/modes`)}
        />
        <SecondaryButton
          label="Free practice"
          onPress={() => router.push(`/course/${selectedCourseId}/practice`)}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted, marginBottom: spacing(3) },
  emptyHeading: { color: colors.text, fontSize: 18, fontWeight: '600', marginBottom: spacing(2) },
  courseName: { color: colors.textMuted, fontSize: 14, marginBottom: spacing(3) },
  courseChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing(2),
    marginBottom: spacing(4),
  },
  chip: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    paddingVertical: spacing(2),
    paddingHorizontal: spacing(3),
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipSelected: { borderColor: colors.primary, backgroundColor: colors.badge },
  chipText: { color: colors.textMuted },
  chipTextSelected: { color: colors.text, fontWeight: '600' },
  examCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(4),
  },
  examTitle: { color: colors.text, fontWeight: '600', fontSize: 16 },
  examCountdown: { color: colors.textMuted, marginTop: spacing(2) },
  startCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(4),
  },
  startHeading: { color: colors.text, fontWeight: '700', fontSize: 20, marginBottom: spacing(2) },
  durationRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2) },
  durationChip: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: spacing(3),
    paddingHorizontal: spacing(4),
    minHeight: 44,
    justifyContent: 'center',
  },
  durationText: { color: '#ffffff', fontWeight: '600' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(4),
    gap: spacing(1),
  },
  cardHeading: { color: colors.text, fontWeight: '600', fontSize: 16, marginBottom: spacing(2) },
  dueRow: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(4),
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dueText: { color: colors.text },
  dueAction: { color: colors.primary, fontWeight: '600' },
  priorityRow: { marginBottom: spacing(2) },
  priorityName: { color: colors.text, fontWeight: '600' },
  priorityMeta: { color: colors.textMuted, fontSize: 13 },
  recentRow: { color: colors.textMuted, marginBottom: spacing(1) },
  plannerRow: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(4),
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 44,
  },
  footer: { marginTop: spacing(2), gap: spacing(2) },
  streakLine: { color: colors.textMuted, fontSize: 13, marginTop: spacing(3) },
});
