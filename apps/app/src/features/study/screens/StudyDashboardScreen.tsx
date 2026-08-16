import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import {
  MASTERY_STATE_LABELS,
  RECOMMENDATION_REASON_LABELS,
  examCountdown,
  nextUpcomingExam,
  type MasteryState,
} from '@avidia/domain';
import { rankConcepts, type StudyRecommendation } from '@avidia/mastery';

import { useAuth } from '../../auth/AuthProvider';
import { getSupabase } from '../../../lib/supabase';
import { ErrorBanner, PrimaryButton, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import { fetchOwnCourse, type Course } from '../../courses/coursesApi';
import { listConcepts } from '../../concepts/conceptsApi';
import { listActiveQuestions } from '../../practice/practiceApi';
import { useUserTimezone } from '../../profile/useTimezone';
import {
  buildConceptSnapshots,
  listConceptMastery,
  listCourseAttempts,
  listCourseExams,
  toUpcomingExams,
  type CourseExamRow,
} from '../studyApi';

/**
 * Minimal study dashboard (M8 spec AF — deliberately NOT the M9+ dashboard):
 * the next upcoming exam, ONE recommended next study action with its honest
 * reasons, and concepts grouped by coarse state. No percentages, no scores,
 * no predictions (spec AG) — every number shown is a count of concepts.
 *
 * All ranking comes from the pure @avidia/mastery engine (spec AH); this
 * screen only fetches the student's own rows and renders the result.
 */

interface DashboardData {
  course: Course;
  exams: CourseExamRow[];
  ranked: StudyRecommendation[];
  conceptNames: Map<string, string>;
}

const STATE_ORDER: MasteryState[] = [
  'due_for_review',
  'needs_review',
  'developing',
  'unassessed',
  'strong',
];

export function StudyDashboardScreen({ courseId }: { courseId: string }) {
  const { user } = useAuth();
  const timeZone = useUserTimezone();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) {
      setLoading(false);
      return;
    }
    try {
      const course = await fetchOwnCourse(client, user.id, courseId);
      if (!course) {
        setError('This course could not be found.');
        setLoading(false);
        return;
      }
      const [concepts, questions, mastery, attempts, exams] = await Promise.all([
        listConcepts(client, courseId),
        listActiveQuestions(client, courseId),
        listConceptMastery(client, courseId),
        listCourseAttempts(client, courseId),
        listCourseExams(client, courseId),
      ]);
      const snapshots = buildConceptSnapshots(concepts, questions, mastery, attempts);
      const ranked = rankConcepts({
        concepts: snapshots,
        exams: toUpcomingExams(exams),
        timeZone,
        now: new Date(),
      });
      setData({
        course,
        exams,
        ranked,
        conceptNames: new Map(concepts.map((c) => [c.id, c.canonical_name])),
      });
      setError(null);
    } catch {
      setError('We could not load your study plan. Please try again.');
    }
    setLoading(false);
  }, [user, courseId, timeZone]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  if (loading) {
    return (
      <Screen title="Study">
        <Text style={styles.muted}>Loading your study plan…</Text>
      </Screen>
    );
  }

  if (!data) {
    return (
      <Screen title="Study">
        <ErrorBanner message={error} />
        <SecondaryButton label="Retry" onPress={load} />
        <SecondaryButton label="Back to courses" onPress={() => router.replace('/courses')} />
      </Screen>
    );
  }

  const upcoming = nextUpcomingExam(data.exams, timeZone);
  const countdown = upcoming ? examCountdown(upcoming.exam_at, timeZone) : null;
  const top = data.ranked.length > 0 ? data.ranked[0] : null;
  const groups = new Map<MasteryState, StudyRecommendation[]>();
  for (const rec of data.ranked) {
    const list = groups.get(rec.masteryState) ?? [];
    list.push(rec);
    groups.set(rec.masteryState, list);
  }

  return (
    <Screen title={`Study — ${data.course.title}`}>
      <ErrorBanner message={error} />

      {upcoming && countdown ? (
        <View style={styles.examCard}>
          <Text style={styles.examTitle}>{upcoming.title}</Text>
          <Text style={styles.examCountdown}>{countdown.label}</Text>
        </View>
      ) : (
        <Text style={styles.muted}>No upcoming exams on the calendar.</Text>
      )}

      {top ? (
        <View style={styles.recommendCard}>
          <Text style={styles.recommendHeading}>Recommended next</Text>
          <Text style={styles.recommendConcept}>
            {data.conceptNames.get(top.conceptId) ?? 'Course material'}
          </Text>
          <Text style={styles.recommendState}>{MASTERY_STATE_LABELS[top.masteryState]}</Text>
          {top.reasonCodes.map((reason) => (
            <Text key={reason} style={styles.reason}>
              • {RECOMMENDATION_REASON_LABELS[reason]}
            </Text>
          ))}
          <PrimaryButton
            label="Start adaptive session"
            onPress={() => router.push(`/course/${courseId}/practice?mode=adaptive`)}
          />
        </View>
      ) : (
        <Text style={styles.muted}>
          No concepts to study yet. Upload course materials and they will appear here once
          processed.
        </Text>
      )}

      {STATE_ORDER.filter((state) => (groups.get(state) ?? []).length > 0).map((state) => {
        const list = groups.get(state)!;
        return (
          <View key={state} style={styles.group}>
            <Text style={styles.groupHeading}>
              {MASTERY_STATE_LABELS[state]} ({list.length})
            </Text>
            {list.slice(0, 8).map((rec) => (
              <Pressable
                key={rec.conceptId}
                accessibilityRole="button"
                onPress={() => router.push(`/course/${courseId}/concept/${rec.conceptId}`)}
                style={styles.conceptRow}
              >
                <Text style={styles.conceptName}>
                  {data.conceptNames.get(rec.conceptId) ?? rec.conceptId}
                </Text>
              </Pressable>
            ))}
            {list.length > 8 ? <Text style={styles.muted}>and {list.length - 8} more…</Text> : null}
          </View>
        );
      })}

      <View style={styles.footerActions}>
        <SecondaryButton
          label="Case Studies"
          onPress={() => router.push(`/course/${courseId}/case-studies`)}
        />
        <SecondaryButton
          label="Simulations"
          onPress={() => router.push(`/course/${courseId}/simulation`)}
        />
        <SecondaryButton
          label="Ask Avidia"
          onPress={() => router.push(`/course/${courseId}/ask-avidia`)}
        />
        <SecondaryButton
          label="Free practice"
          onPress={() => router.push(`/course/${courseId}/practice`)}
        />
        <SecondaryButton
          label="Back to course"
          onPress={() => router.push(`/course/${courseId}`)}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted, marginBottom: spacing(4) },
  examCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(4),
  },
  examTitle: { color: colors.text, fontWeight: '600', fontSize: 16 },
  examCountdown: { color: colors.textMuted, marginTop: spacing(2) },
  recommendCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(6),
    gap: spacing(2),
  },
  recommendHeading: { color: colors.textMuted, fontSize: 13, textTransform: 'uppercase' },
  recommendConcept: { color: colors.text, fontWeight: '700', fontSize: 18 },
  recommendState: { color: colors.textMuted, marginBottom: spacing(2) },
  reason: { color: colors.text, fontSize: 14 },
  group: { marginBottom: spacing(4) },
  groupHeading: { color: colors.text, fontWeight: '600', marginBottom: spacing(2) },
  conceptRow: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    padding: spacing(3),
    marginBottom: spacing(2),
  },
  conceptName: { color: colors.text },
  footerActions: { marginTop: spacing(4), gap: spacing(2) },
});
