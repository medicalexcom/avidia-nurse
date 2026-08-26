import { useCallback, useEffect, useRef, useState } from 'react';
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
import {
  listLearningRequests,
  requestLearningArtifact,
  type LearningRequest,
} from '../../aiLearning/aiLearningApi';

// Generation is asynchronous background work (mirrors
// SimulationLibraryScreen's poll — see that screen for the full rationale).
// Timeout kept above the worker's 5-minute cron cadence plus generation time.
const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 420000;

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
  /** True once the course has ANY concept — real or LLM-syllabus-proposed —
   * distinct from `ranked` being empty, which can also happen for other
   * reasons and should not offer the no-upload generate action. */
  hasConcepts: boolean;
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
  const [generating, setGenerating] = useState(false);
  // question_set requests still queued or being processed for this course —
  // rendered as "Generating study questions…" while the no-upload fallback
  // (course name -> LLM concept list -> general-knowledge questions) runs.
  const [pendingRequest, setPendingRequest] = useState<LearningRequest | null>(null);
  // The most recent failed request, shown until dismissed or a new
  // generation starts — mirrors SimulationLibraryScreen's failure handling.
  const [failedRequest, setFailedRequest] = useState<LearningRequest | null>(null);
  const [dismissedFailedId, setDismissedFailedId] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollToken = useRef(0);

  const stopPolling = useCallback(() => {
    pollToken.current += 1;
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

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
      const [concepts, questions, mastery, attempts, exams, learningRequests] = await Promise.all([
        listConcepts(client, courseId),
        listActiveQuestions(client, courseId),
        listConceptMastery(client, courseId),
        listCourseAttempts(client, courseId),
        listCourseExams(client, courseId),
        listLearningRequests(client, courseId, 'question_set'),
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
        hasConcepts: concepts.length > 0,
      });
      setPendingRequest(
        learningRequests.find((r) => r.status === 'queued' || r.status === 'processing') ?? null
      );
      setFailedRequest(learningRequests.find((r) => r.status === 'failed') ?? null);
      setError(null);
    } catch {
      setError('We could not load your study plan. Please try again.');
    }
    setLoading(false);
  }, [user, courseId, timeZone]);

  // While a question_set request is still queued/processing, keep polling
  // and reloading so the new concepts/questions appear on their own once
  // ready, without the student having to refresh manually.
  const pollUntilSettled = useCallback(() => {
    stopPolling();
    const token = pollToken.current;
    const startedAt = Date.now();
    const tick = async () => {
      if (token !== pollToken.current) return;
      await load();
      if (token !== pollToken.current) return;
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) return;
      pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
  }, [load, stopPolling]);

  useEffect(() => {
    if (pendingRequest) pollUntilSettled();
    else stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRequest?.id, pendingRequest?.status]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const generateFromCourseName = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) return;
    setGenerating(true);
    setError(null);
    try {
      const request = await requestLearningArtifact(client, user.id, courseId, 'question_set', {});
      if (request.status === 'queued' || request.status === 'processing') {
        setPendingRequest(request);
      } else {
        await load();
      }
    } catch {
      setError('Avidia could not start generating study questions. Please try again.');
    }
    setGenerating(false);
  }, [courseId, load, user]);

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
    <Screen testID="study-dashboard" title={`Study — ${data.course.title}`}>
      <ErrorBanner message={error} />

      {upcoming && countdown ? (
        <View testID="exam-info-card" style={styles.examCard}>
          <Text style={styles.examTitle}>{upcoming.title}</Text>
          <Text style={styles.examCountdown}>{countdown.label}</Text>
        </View>
      ) : (
        <Text style={styles.muted}>No upcoming exams on the calendar.</Text>
      )}

      {top ? (
        <View testID="recommendation-card" style={styles.recommendCard}>
          <Text style={styles.recommendHeading}>Recommended next</Text>
          <Text testID="concept-name" style={styles.recommendConcept}>
            {data.conceptNames.get(top.conceptId) ?? 'Course material'}
          </Text>
          <Text style={styles.recommendState}>{MASTERY_STATE_LABELS[top.masteryState]}</Text>
          {top.reasonCodes.map((reason) => (
            <Text testID={`reason-${reason}`} key={reason} style={styles.reason}>
              • {RECOMMENDATION_REASON_LABELS[reason]}
            </Text>
          ))}
          <PrimaryButton
            testID="start-adaptive-session-button"
            label="Start adaptive session"
            onPress={() => router.push(`/course/${courseId}/practice?mode=adaptive`)}
          />
        </View>
      ) : data.hasConcepts ? (
        <Text style={styles.muted}>
          No concepts to study yet. Upload course materials and they will appear here once
          processed.
        </Text>
      ) : (
        <View testID="no-concepts-card" style={styles.recommendCard}>
          <Text style={styles.muted}>
            No concepts to study yet. Upload course materials, or let Avidia build study questions
            from your course name in the meantime — course material always takes priority once
            it&apos;s processed.
          </Text>
          {pendingRequest ? (
            <Text style={styles.reason}>
              Avidia is building a study topic list from your course name and writing practice
              questions from general nursing knowledge. This will appear here automatically — no
              need to refresh.
            </Text>
          ) : (
            <>
              {failedRequest && dismissedFailedId !== failedRequest.id ? (
                <>
                  <Text style={styles.reason}>
                    Avidia could not generate study questions. Try again, or dismiss.
                  </Text>
                  <SecondaryButton
                    label="Dismiss"
                    onPress={() => setDismissedFailedId(failedRequest.id)}
                  />
                </>
              ) : null}
              <PrimaryButton
                testID="generate-questions-button"
                label="Generate study questions from course name"
                onPress={generateFromCourseName}
                busy={generating}
              />
            </>
          )}
        </View>
      )}

      {STATE_ORDER.filter((state) => (groups.get(state) ?? []).length > 0).map((state) => {
        const list = groups.get(state)!;
        return (
          <View testID={`concept-group-${state}`} key={state} style={styles.group}>
            <Text style={styles.groupHeading}>
              {MASTERY_STATE_LABELS[state]} ({list.length})
            </Text>
            {list.slice(0, 8).map((rec) => (
              <Pressable
                testID={`concept-${rec.conceptId}`}
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

      <View testID="footer-actions" style={styles.footerActions}>
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
