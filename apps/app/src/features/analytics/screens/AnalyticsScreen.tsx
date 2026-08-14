import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import {
  COGNITIVE_LEVEL_LABELS,
  MASTERY_STATE_LABELS,
  QUESTION_DIFFICULTY_LABELS,
  formatInZone,
  type MasteryState,
} from '@avidia/domain';
import {
  ATTENTION_REASON_LABELS,
  CALIBRATION_CELL_LABELS,
  READINESS_LABELS,
  READINESS_REASON_LABELS,
  TREND_LABELS,
  getCourseAnalytics,
  type AccuracySlice,
  type ConceptAnalytics,
  type CourseAnalytics,
  type InsightAction,
} from '@avidia/analytics';

import { useAuth } from '../../auth/AuthProvider';
import { getSupabase } from '../../../lib/supabase';
import { trackEvent } from '../../../lib/analytics';
import { ErrorBanner, PrimaryButton, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import { fetchOwnCourse, type Course } from '../../courses/coursesApi';
import { useUserTimezone } from '../../profile/useTimezone';
import { loadAnalyticsInput } from '../analyticsApi';

/**
 * Per-course analytics — M12 (spec D/AE/AG/AH/AI).
 *
 * This screen renders the pure `@avidia/analytics` read model VERBATIM: no
 * metric is computed here (spec A), charts are restrained bars with text
 * alternatives (spec AE/AF), every section states its evidence counts, and
 * nothing on this page is ever a grade prediction (spec R). Mobile gets a
 * single card column; desktop (≥ 900px) flows the same cards into two
 * columns (spec AG/AH).
 */

const DESKTOP_MIN_WIDTH = 900;

const STATE_ORDER: MasteryState[] = [
  'strong',
  'developing',
  'needs_review',
  'due_for_review',
  'unassessed',
];

/** Whole percents only — no fake precision (spec E). */
function pct(fraction: number | null): string {
  return fraction === null ? '—' : `${Math.round(fraction * 100)}%`;
}

function accuracyText(slice: AccuracySlice | null): string {
  if (!slice || slice.accuracy === null) return 'Not enough data yet';
  return `${pct(slice.accuracy)} (${slice.correct} of ${slice.total})`;
}

export function AnalyticsScreen({ courseId }: { courseId: string }) {
  const { user } = useAuth();
  const timeZone = useUserTimezone();
  const { width } = useWindowDimensions();
  const [course, setCourse] = useState<Course | null>(null);
  const [analytics, setAnalytics] = useState<CourseAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) {
      setLoading(false);
      return;
    }
    try {
      const own = await fetchOwnCourse(client, user.id, courseId);
      if (!own) {
        setError('This course could not be found.');
        setLoading(false);
        return;
      }
      const input = await loadAnalyticsInput(client, courseId, timeZone);
      setCourse(own);
      setAnalytics(getCourseAnalytics(input));
      setError(null);
      // Privacy-conscious event (spec AM): the name only — no metrics, no
      // course content, nothing about performance leaves the device.
      trackEvent({ name: 'analytics_viewed' });
    } catch {
      setError('We could not load your analytics. Please try again.');
    }
    setLoading(false);
  }, [user, courseId, timeZone]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onAction = useCallback(
    (action: InsightAction) => {
      switch (action.kind) {
        case 'adaptive_session':
          router.push(`/course/${courseId}/practice?mode=adaptive`);
          break;
        case 'practice_concept':
          router.push(`/course/${courseId}/concept/${action.conceptId}`);
          break;
        case 'study_mode':
          router.push(`/course/${courseId}/modes`);
          break;
        case 'simulation':
          router.push(`/course/${courseId}/simulation`);
          break;
      }
    },
    [courseId]
  );

  if (loading) {
    return (
      <Screen title="Analytics">
        <Text style={styles.muted}>Crunching your course data…</Text>
      </Screen>
    );
  }

  if (!analytics || !course) {
    return (
      <Screen title="Analytics">
        <ErrorBanner message={error} />
        <SecondaryButton label="Retry" onPress={load} />
        <SecondaryButton label="Back to courses" onPress={() => router.replace('/courses')} />
      </Screen>
    );
  }

  // Empty state (spec AI): honest, encouraging, with a way forward.
  if (analytics.isEmpty) {
    return (
      <Screen title={`Analytics — ${course.title}`}>
        <ErrorBanner message={error} />
        <View style={styles.card}>
          <Text style={styles.cardHeading}>Nothing to analyze yet</Text>
          <Text style={styles.body}>
            Analytics build from your own practice: answer questions or run a simulation and this
            page will start showing where you stand — never before you have real evidence.
          </Text>
          <PrimaryButton
            label="Start practicing"
            onPress={() => router.push(`/course/${courseId}/practice?mode=adaptive`)}
          />
        </View>
        <SecondaryButton
          label="Back to course"
          onPress={() => router.push(`/course/${courseId}`)}
        />
      </Screen>
    );
  }

  const a = analytics;
  const desktop = width >= DESKTOP_MIN_WIDTH;
  const maxStateCount = Math.max(1, ...STATE_ORDER.map((s) => a.distribution.distribution[s]));
  const maxDaily = Math.max(1, ...a.consistency.dailyAttemptsLast7);
  const activeModes = a.modes.filter((m) => m.sessionsStarted > 0);

  return (
    <Screen title={`Analytics — ${course.title}`}>
      <ErrorBanner message={error} />

      {/* Insights first (spec AC/AD): what to DO, not just what happened. */}
      {a.insights.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.cardHeading}>What to do next</Text>
          {a.insights.map((insight) => {
            const action = insight.action;
            return (
              <View key={insight.code} style={styles.insightRow}>
                <Text style={styles.body}>{insight.message}</Text>
                {action ? (
                  <SecondaryButton
                    label={
                      action.kind === 'adaptive_session'
                        ? 'Start adaptive session'
                        : action.kind === 'practice_concept'
                          ? `Review ${action.conceptName}`
                          : action.kind === 'study_mode'
                            ? 'Open study modes'
                            : 'Open simulations'
                    }
                    onPress={() => onAction(action)}
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

      <View style={desktop ? styles.columns : undefined}>
        <View style={desktop ? styles.column : undefined}>
          {/* Exam readiness (spec N–R): a state with WHY, never a grade. */}
          <View style={styles.card}>
            <Text style={styles.cardHeading}>Exam readiness</Text>
            {a.readiness.exam ? (
              <Text style={styles.body}>
                {a.readiness.exam.title} — {formatInZone(a.readiness.exam.examAt, timeZone)}
                {a.readiness.daysUntilExam !== null && a.readiness.daysUntilExam >= 0
                  ? ` (${a.readiness.daysUntilExam} day${a.readiness.daysUntilExam === 1 ? '' : 's'} away)`
                  : ''}
              </Text>
            ) : (
              <Text style={styles.muted}>No upcoming exam on the calendar.</Text>
            )}
            <Text style={styles.readinessState}>{READINESS_LABELS[a.readiness.state]}</Text>
            {a.readiness.reasons.map((reason) => (
              <Text key={reason} style={styles.body}>
                • {READINESS_REASON_LABELS[reason]}
              </Text>
            ))}
            {a.readiness.lowConfidence ? (
              <Text style={styles.caveat}>
                Based on limited evidence so far — this picture will sharpen as you practice.
              </Text>
            ) : null}
            {a.readiness.focus.length > 0 ? (
              <View style={styles.subSection}>
                <Text style={styles.subHeading}>Focus next</Text>
                {a.readiness.focus.map((rec) => {
                  const match = a.conceptAnalytics.concepts.find(
                    (c) => c.conceptId === rec.conceptId
                  );
                  return (
                    <Pressable
                      key={rec.conceptId}
                      accessibilityRole="button"
                      onPress={() => router.push(`/course/${courseId}/concept/${rec.conceptId}`)}
                      style={styles.linkRow}
                    >
                      <Text style={styles.linkText}>
                        {match?.canonicalName ?? 'Course concept'}
                      </Text>
                      <Text style={styles.linkMeta}>{MASTERY_STATE_LABELS[rec.masteryState]}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
            <Text style={styles.caveat}>
              Readiness describes your preparation, not your grade — no score is being predicted.
            </Text>
          </View>

          {/* Mastery distribution (spec E). */}
          <View style={styles.card}>
            <Text style={styles.cardHeading}>Mastery map</Text>
            <Text style={styles.muted}>
              {a.distribution.assessedConcepts} of {a.distribution.totalConcepts} concepts assessed
              so far
              {a.distribution.assessedCoverage !== null
                ? ` (${pct(a.distribution.assessedCoverage)} coverage)`
                : ''}
            </Text>
            {STATE_ORDER.map((state) => {
              const count = a.distribution.distribution[state];
              return (
                <View
                  key={state}
                  style={styles.barRow}
                  accessibilityLabel={`${MASTERY_STATE_LABELS[state]}: ${count} concepts`}
                >
                  <Text style={styles.barLabel}>{MASTERY_STATE_LABELS[state]}</Text>
                  <View style={styles.barTrack}>
                    <View
                      style={[
                        styles.barFill,
                        { width: `${Math.round((count / maxStateCount) * 100)}%` },
                        state === 'needs_review' || state === 'due_for_review'
                          ? styles.barFillWarn
                          : null,
                        state === 'unassessed' ? styles.barFillMutedTone : null,
                      ]}
                    />
                  </View>
                  <Text style={styles.barCount}>{count}</Text>
                </View>
              );
            })}
          </View>

          {/* Needs attention (spec H) — evidence-backed, never “unassessed = weak”. */}
          <View style={styles.card}>
            <Text style={styles.cardHeading}>Needs attention</Text>
            {a.conceptAnalytics.needsAttention.length === 0 ? (
              <Text style={styles.muted}>
                No concept currently shows evidence of trouble. Keep practicing to keep it that way.
              </Text>
            ) : (
              a.conceptAnalytics.needsAttention.map((concept: ConceptAnalytics) => (
                <Pressable
                  key={concept.conceptId}
                  accessibilityRole="button"
                  onPress={() => router.push(`/course/${courseId}/concept/${concept.conceptId}`)}
                  style={styles.attentionRow}
                >
                  <Text style={styles.linkText}>{concept.canonicalName}</Text>
                  {concept.attentionReasons.map((reason) => (
                    <Text key={reason} style={styles.linkMeta}>
                      • {ATTENTION_REASON_LABELS[reason]}
                    </Text>
                  ))}
                </Pressable>
              ))
            )}
          </View>

          {/* Strengths (spec I) — only with sufficient evidence. */}
          <View style={styles.card}>
            <Text style={styles.cardHeading}>Strengths</Text>
            {a.conceptAnalytics.strengths.length === 0 ? (
              <Text style={styles.muted}>
                Strengths appear once a concept is strong with enough attempts behind it.
              </Text>
            ) : (
              a.conceptAnalytics.strengths.map((concept) => (
                <Text key={concept.conceptId} style={styles.body}>
                  ✓ {concept.canonicalName}
                </Text>
              ))
            )}
          </View>

          {/* Study consistency (spec T/U/V) — activity facts, no minute-counting. */}
          <View style={styles.card}>
            <Text style={styles.cardHeading}>Consistency</Text>
            <Text style={styles.body}>
              {a.consistency.streakDays > 0
                ? `${a.consistency.streakDays}-day study streak`
                : 'No active streak — today is a fine day to start one'}
            </Text>
            <Text style={styles.muted}>
              Active {a.consistency.activeDaysLast7} of the last 7 days and{' '}
              {a.consistency.activeDaysLast30} of the last 30 · {a.consistency.attemptsLast7}{' '}
              questions this week
            </Text>
            <View
              style={styles.sparkRow}
              accessibilityLabel={`Questions answered per day, most recent first: ${a.consistency.dailyAttemptsLast7.join(', ')}`}
            >
              {a.consistency.dailyAttemptsLast7.map((count, i) => (
                <View key={i} style={styles.sparkSlot}>
                  <View
                    style={[
                      styles.sparkBar,
                      { height: 4 + Math.round((count / maxDaily) * 28) },
                      count === 0 ? styles.sparkBarEmpty : null,
                    ]}
                  />
                  <Text style={styles.sparkLabel}>{i === 0 ? 'today' : `-${i}d`}</Text>
                </View>
              ))}
            </View>
            <Text style={styles.muted}>
              {a.consistency.completedSessionsLast30} sessions completed in the last 30 days
              {a.consistency.abandonedSessionsLast30 > 0
                ? ` (${a.consistency.abandonedSessionsLast30} left unfinished)`
                : ''}
            </Text>
          </View>
        </View>

        <View style={desktop ? styles.column : undefined}>
          {/* Week over week (spec C/G). */}
          <View style={styles.card}>
            <Text style={styles.cardHeading}>This week</Text>
            <Text style={styles.trendState}>{TREND_LABELS[a.weekOverWeek.trend]}</Text>
            <Text style={styles.muted}>
              This week: {pct(a.weekOverWeek.recentAccuracy)} across {a.weekOverWeek.recentCount}{' '}
              questions · previous week: {pct(a.weekOverWeek.previousAccuracy)} across{' '}
              {a.weekOverWeek.previousCount}
            </Text>
            {a.weekOverWeek.trend === 'insufficient' ? (
              <Text style={styles.caveat}>
                Trends need at least a handful of questions in both weeks — no verdicts from tiny
                samples.
              </Text>
            ) : null}
          </View>

          {/* Cognitive levels + difficulty (spec J/K). */}
          <View style={styles.card}>
            <Text style={styles.cardHeading}>How you think</Text>
            {a.cognitiveLevels.map((row) => (
              <View key={row.key} style={styles.tableRow}>
                <Text style={styles.tableLabel}>{COGNITIVE_LEVEL_LABELS[row.key]}</Text>
                <Text style={styles.tableValue}>{accuracyText(row.accuracy)}</Text>
              </View>
            ))}
            <Text style={styles.subHeading}>By difficulty</Text>
            {a.difficulties.map((row) => (
              <View key={row.key} style={styles.tableRow}>
                <Text style={styles.tableLabel}>{QUESTION_DIFFICULTY_LABELS[row.key]}</Text>
                <Text style={styles.tableValue}>{accuracyText(row.accuracy)}</Text>
              </View>
            ))}
          </View>

          {/* Confidence calibration (spec L) — supportive, never scolding. */}
          <View style={styles.card}>
            <Text style={styles.cardHeading}>Confidence check</Text>
            {!a.calibration.sufficient ? (
              <Text style={styles.muted}>
                Tag your confidence on more answers and this section will show how well your gut
                matches your results.
              </Text>
            ) : (
              <>
                <Text style={styles.body}>
                  Your confidence matched the outcome on {pct(a.calibration.calibratedShare)} of
                  tagged answers.
                </Text>
                {(Object.keys(a.calibration.cells) as (keyof typeof a.calibration.cells)[]).map(
                  (cell) => (
                    <View key={cell} style={styles.tableRow}>
                      <Text style={styles.tableLabel}>{CALIBRATION_CELL_LABELS[cell]}</Text>
                      <Text style={styles.tableValue}>{a.calibration.cells[cell]}</Text>
                    </View>
                  )
                )}
                {a.calibration.overconfidenceSignal ? (
                  <Text style={styles.caveat}>
                    A few “certain” answers didn’t land — worth a second look at those concepts.
                    That’s a normal part of learning, and exactly what review is for.
                  </Text>
                ) : null}
              </>
            )}
          </View>

          {/* Study modes + medication (spec W/X). */}
          <View style={styles.card}>
            <Text style={styles.cardHeading}>Study modes</Text>
            {activeModes.length === 0 ? (
              <Text style={styles.muted}>No mode sessions yet — try one from the Modes page.</Text>
            ) : (
              activeModes.map((mode) => (
                <View key={mode.modeId} style={styles.tableRow}>
                  <Text style={styles.tableLabel}>{mode.label}</Text>
                  <Text style={styles.tableValue}>
                    {mode.sessionsCompleted}/{mode.sessionsStarted} done ·{' '}
                    {accuracyText(mode.accuracy)}
                  </Text>
                </View>
              ))
            )}
            <Text style={styles.subHeading}>Medication questions</Text>
            <Text style={styles.body}>{accuracyText(a.medication.accuracy)}</Text>
          </View>

          {/* Clinical judgment (spec Y) — side by side, never a blended score. */}
          <View style={styles.card}>
            <Text style={styles.cardHeading}>Clinical judgment</Text>
            <View style={styles.tableRow}>
              <Text style={styles.tableLabel}>Analysis questions</Text>
              <Text style={styles.tableValue}>
                {accuracyText(a.clinicalJudgment.analysisQuestions.accuracy)}
              </Text>
            </View>
            <View style={styles.tableRow}>
              <Text style={styles.tableLabel}>Prioritization questions</Text>
              <Text style={styles.tableValue}>
                {accuracyText(a.clinicalJudgment.prioritizationQuestions.accuracy)}
              </Text>
            </View>
            {a.clinicalJudgment.simulationDimensions.map((dim) => (
              <View key={dim.dimension} style={styles.tableRow}>
                <Text style={styles.tableLabel}>{dim.label}</Text>
                <Text style={styles.tableValue}>
                  {dim.share === null ? 'Not enough data yet' : `${pct(dim.share)} of points`}
                </Text>
              </View>
            ))}
            <Text style={styles.muted}>
              Question accuracy and simulation points are shown separately — they measure different
              things.
            </Text>
          </View>

          {/* Simulation performance (spec Z/AA). */}
          <View style={styles.card}>
            <Text style={styles.cardHeading}>Simulations</Text>
            {a.simulation.completedCount === 0 ? (
              <Text style={styles.muted}>
                No completed simulations yet. A simulation shows how your knowledge holds up at the
                bedside.
              </Text>
            ) : (
              <>
                <Text style={styles.body}>
                  {a.simulation.completedCount} completed — {a.simulation.outcomes.stabilized}{' '}
                  stabilized, {a.simulation.outcomes.deteriorated} deteriorated,{' '}
                  {a.simulation.outcomes.complication} with complications,{' '}
                  {a.simulation.outcomes.timeout} timed out
                </Text>
                <Text style={styles.muted}>
                  Score trend: {TREND_LABELS[a.simulation.scoreTrend]}
                  {a.simulation.weakestDimension
                    ? ` · weakest area: ${a.simulation.weakestDimension.label}`
                    : ''}
                </Text>
                {a.simulation.totalCriticalMissed + a.simulation.totalUnsafeActions > 0 ? (
                  <Text style={styles.muted}>
                    {a.simulation.totalCriticalMissed} critical action(s) missed and{' '}
                    {a.simulation.totalUnsafeActions} unsafe action(s) across all runs — each
                    debrief lists the specifics.
                  </Text>
                ) : null}
                {a.simulation.recent.slice(0, 3).map((run) => (
                  <View key={run.sessionId} style={styles.tableRow}>
                    <Text style={styles.tableLabel}>{run.caseTitle}</Text>
                    <Text style={styles.tableValue}>
                      {run.outcomeLabel} · {run.earned}/{run.possible} pts
                    </Text>
                  </View>
                ))}
              </>
            )}
          </View>

          {/* Error patterns (spec AB). */}
          {a.errorPatterns.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardHeading}>Error patterns</Text>
              {a.errorPatterns.map((pattern) => (
                <Text key={pattern.code} style={styles.body}>
                  • {pattern.label} ({pattern.evidenceCount} answers)
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      </View>

      <View style={styles.footerActions}>
        <SecondaryButton
          label="Study plan"
          onPress={() => router.push(`/course/${courseId}/study`)}
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
  muted: { color: colors.textMuted, fontSize: 14, lineHeight: 20, marginBottom: spacing(2) },
  body: { color: colors.text, fontSize: 14, lineHeight: 20, marginBottom: spacing(1) },
  caveat: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
    fontStyle: 'italic',
    marginTop: spacing(2),
  },
  columns: { flexDirection: 'row', gap: spacing(4), alignItems: 'flex-start' },
  column: { flex: 1 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(4),
  },
  cardHeading: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: spacing(2),
  },
  insightRow: { marginBottom: spacing(3), gap: spacing(2) },
  readinessState: {
    color: colors.text,
    fontWeight: '700',
    fontSize: 20,
    marginVertical: spacing(2),
  },
  trendState: { color: colors.text, fontWeight: '700', fontSize: 18, marginBottom: spacing(1) },
  subSection: { marginTop: spacing(3) },
  subHeading: {
    color: colors.text,
    fontWeight: '600',
    fontSize: 14,
    marginTop: spacing(3),
    marginBottom: spacing(1),
  },
  linkRow: {
    backgroundColor: colors.background,
    borderRadius: 8,
    padding: spacing(3),
    marginBottom: spacing(2),
  },
  linkText: { color: colors.text, fontWeight: '600', fontSize: 14 },
  linkMeta: { color: colors.textMuted, fontSize: 13, marginTop: spacing(0.5) },
  attentionRow: {
    backgroundColor: colors.background,
    borderRadius: 8,
    padding: spacing(3),
    marginBottom: spacing(2),
  },
  barRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2) },
  barLabel: { color: colors.text, fontSize: 13, width: 110 },
  barTrack: {
    flex: 1,
    height: 10,
    backgroundColor: colors.background,
    borderRadius: 999,
    overflow: 'hidden',
    marginHorizontal: spacing(2),
  },
  barFill: { height: '100%', backgroundColor: colors.primary, borderRadius: 999 },
  barFillWarn: { backgroundColor: '#d97706' },
  barFillMutedTone: { backgroundColor: colors.border },
  barCount: { color: colors.text, fontSize: 13, fontWeight: '600', width: 28, textAlign: 'right' },
  sparkRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing(2),
    marginVertical: spacing(2),
  },
  sparkSlot: { alignItems: 'center', gap: spacing(1) },
  sparkBar: { width: 16, borderRadius: 4, backgroundColor: colors.primary },
  sparkBarEmpty: { backgroundColor: colors.border },
  sparkLabel: { color: colors.textMuted, fontSize: 10 },
  tableRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing(3),
    paddingVertical: spacing(1.5),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  tableLabel: { color: colors.text, fontSize: 14, flexShrink: 1 },
  tableValue: { color: colors.textMuted, fontSize: 14, textAlign: 'right', flexShrink: 0 },
  footerActions: { marginTop: spacing(2), gap: spacing(2) },
});
