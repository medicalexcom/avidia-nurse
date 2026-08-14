import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { buildSessionQuestionOrder } from '@avidia/assessment/src/mix';
import {
  buildAdaptiveQuestionOrder,
  rankConcepts,
  type SelectableQuestion,
  type StudyRecommendation,
} from '@avidia/mastery';
import {
  CONFIDENCE_LEVELS,
  CONFIDENCE_LEVEL_LABELS,
  MASTERY_STATE_LABELS,
  QUESTION_FEEDBACK_REASONS,
  QUESTION_FEEDBACK_REASON_LABELS,
  QUESTION_SOURCE_TYPE_LABELS,
  QUESTION_TYPE_LABELS,
  RECOMMENDATION_REASON_LABELS,
  type ConfidenceLevel,
  type QuestionFeedbackReason,
} from '@avidia/domain';

import { useAuth } from '../../auth/AuthProvider';
import { trackEvent } from '../../../lib/analytics';
import { getSupabase } from '../../../lib/supabase';
import { ErrorBanner, PrimaryButton, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import { fetchOwnCourse, type Course } from '../../courses/coursesApi';
import { listConcepts } from '../../concepts/conceptsApi';
import { useUserTimezone } from '../../profile/useTimezone';
import {
  buildConceptSnapshots,
  listConceptMastery,
  listCourseAttempts,
  listCourseExams,
  seenQuestionIds,
  toUpcomingExams,
  type ConceptMasteryRow,
  type CourseAttemptRow,
  type CourseExamRow,
  type StudyConceptRow,
} from '../../study/studyApi';
import {
  MISCONCEPTION_REVISIT_MESSAGE,
  SESSION_DURATION_MINUTES,
  appendLocalAttempt,
  applyMasteryEcho,
  buildSessionSummary,
  dueReviewConceptIds,
  estimateRemainingMinutes,
  hasActiveMisconceptionFactor,
  questionCountForDuration,
  remainingPlanQuestionIds,
  reorderRemainingQuestions,
  type SessionSummary,
} from '../../today/plan';
import {
  closeStudySession,
  createStudySession,
  findResumableSession,
  insertSessionPlan,
  listActiveQuestions,
  listQuestionSourceRefs,
  listSessionAttempts,
  listSessionPlan,
  markPlanSkipped,
  submitAttempt,
  submitQuestionFeedback,
  type AttemptResponse,
  type AttemptResult,
  type PracticeQuestionRow,
  type QuestionSourceRef,
  type StudySessionRow,
} from '../practiceApi';

/**
 * Practice session flow (M7 spec V/W/X/U/AH; M9 daily experience).
 *
 *   setup → one question at a time → locked answer + rationale → results
 *
 * In the default 'practice' mode, selection is deterministic-random and
 * balanced across concepts (M7 spec V/Z/AL) — this mode is provably
 * untouched by M9. In 'adaptive' mode the SAME screen is the daily session
 * (M9 spec N: no disconnected "quick mode"): the student picks a duration
 * (spec B), the pure @avidia/mastery engine plans the session from the
 * persisted bank (spec C — never an AI call), the plan is persisted so a
 * closed app can RESUME (spec O), each answer's server-returned aggregate
 * re-ranks the remaining items (spec J — client never recomputes mastery),
 * skips are recorded explicitly and never touch mastery (spec AB), and the
 * completion summary is honest counts only (spec M). Answers are immutable
 * once submitted (M7 spec W).
 */

const SESSION_SIZE_CHOICES = [5, 10, 20];
export const MAX_SESSION_QUESTIONS = 50;

interface AnsweredQuestion {
  question: PracticeQuestionRow;
  result: AttemptResult;
  confidence: ConfidenceLevel | null;
}

/** One activity for the summary — mirrors what the server recorded. */
interface ActivityRecord {
  questionId: string;
  conceptId: string | null;
  isCorrect: boolean;
  masteryDelta: number | null;
}

interface AdaptiveContext {
  conceptRows: StudyConceptRow[];
  masteryRows: ConceptMasteryRow[];
  attempts: CourseAttemptRow[];
  exams: CourseExamRow[];
  ranked: StudyRecommendation[];
}

type Phase =
  | { name: 'loading' }
  | { name: 'setup' }
  | { name: 'question'; index: number; result: AttemptResult | null }
  | { name: 'results' };

const toSelectable =
  (seen: ReadonlySet<string>) =>
  (question: PracticeQuestionRow): SelectableQuestion => ({
    questionId: question.id,
    conceptId: question.concept_id,
    difficulty: question.difficulty,
    cognitiveLevel: question.cognitive_level,
    seen: seen.has(question.id),
  });

export function PracticeScreen({
  courseId,
  mode = 'practice',
  minutes = null,
  resume = false,
}: {
  courseId: string;
  mode?: 'practice' | 'adaptive';
  /** M9 spec B: launch directly into a session of this duration. */
  minutes?: number | null;
  /** M9 spec O: continue the open session without asking. */
  resume?: boolean;
}) {
  const { user } = useAuth();
  const timeZone = useUserTimezone();
  const [course, setCourse] = useState<Course | null>(null);
  const [pool, setPool] = useState<PracticeQuestionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [session, setSession] = useState<StudySessionRow | null>(null);
  const [ordered, setOrdered] = useState<PracticeQuestionRow[]>([]);
  const [answers, setAnswers] = useState<AnsweredQuestion[]>([]);
  // M9 adaptive-session state. All ranking values below come from the pure
  // engine over server rows; the screen never computes mastery itself.
  const [conceptRows, setConceptRows] = useState<StudyConceptRow[]>([]);
  const [masteryRows, setMasteryRows] = useState<ConceptMasteryRow[]>([]);
  const [attempts, setAttempts] = useState<CourseAttemptRow[]>([]);
  const [exams, setExams] = useState<CourseExamRow[]>([]);
  const [ranked, setRanked] = useState<StudyRecommendation[]>([]);
  const [conceptNames, setConceptNames] = useState<Map<string, string>>(new Map());
  const [records, setRecords] = useState<ActivityRecord[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [dueAtStart, setDueAtStart] = useState<ReadonlySet<string>>(new Set());
  const [resumable, setResumable] = useState<StudySessionRow | null>(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const questionShownAt = useRef<number>(Date.now());
  const autoLaunched = useRef(false);

  // Move to setup only from loading/setup — never clobber an active question
  // or the results view when focus returns to the screen.
  const settle = () =>
    setPhase((previous) =>
      previous.name === 'loading' || previous.name === 'setup' ? { name: 'setup' } : previous
    );

  /**
   * Rank the course with the pure engine from the student's own rows (M8
   * spec AH). Also keeps local copies so in-session adaptation can re-rank
   * without refetching (M9 spec J).
   */
  const loadAdaptiveContext = async (
    client: NonNullable<ReturnType<typeof getSupabase>>,
    poolArg: PracticeQuestionRow[]
  ): Promise<AdaptiveContext> => {
    const [concepts, mastery, courseAttempts, courseExams] = await Promise.all([
      listConcepts(client, courseId),
      listConceptMastery(client, courseId),
      listCourseAttempts(client, courseId),
      listCourseExams(client, courseId),
    ]);
    const rankedNow = rankConcepts({
      concepts: buildConceptSnapshots(concepts, poolArg, mastery, courseAttempts),
      exams: toUpcomingExams(courseExams),
      timeZone,
      now: new Date(),
    });
    setConceptRows(concepts);
    setMasteryRows(mastery);
    setAttempts(courseAttempts);
    setExams(courseExams);
    setRanked(rankedNow);
    setConceptNames(new Map(concepts.map((c) => [c.id, c.canonical_name])));
    return {
      conceptRows: concepts,
      masteryRows: mastery,
      attempts: courseAttempts,
      exams: courseExams,
      ranked: rankedNow,
    };
  };

  /**
   * Start a daily adaptive session for a duration (M9 spec B/C/D): the M8
   * engine plans mastery-appropriate questions from the persisted bank, the
   * plan is stored for resume (spec O), and a small bank simply shrinks the
   * session (spec W/X — never a blocking call, never per-question AI).
   */
  const startAdaptiveSession = async (requestedMinutes: number, poolArg: PracticeQuestionRow[]) => {
    const client = getSupabase();
    if (!client) return;
    const count = questionCountForDuration(requestedMinutes, poolArg.length);
    if (count === 0) {
      settle();
      return;
    }
    try {
      const context = await loadAdaptiveContext(client, poolArg);
      const created = await createStudySession(
        client,
        courseId,
        count,
        'adaptive',
        requestedMinutes
      );
      const seen = seenQuestionIds(context.attempts);
      const orderedIds = buildAdaptiveQuestionOrder({
        questions: poolArg.map(toSelectable(seen)),
        ranked: context.ranked,
        sessionSize: count,
        seed: created.id,
      });
      try {
        await insertSessionPlan(client, created.id, orderedIds);
      } catch {
        // Spec W: if plan persistence fails, the session still runs — only
        // resume-after-restart is unavailable for this one session.
      }
      trackEvent({
        name: 'daily_session_started',
        requestedMinutes,
        plannedQuestions: orderedIds.length,
      });
      const byId = new Map(poolArg.map((question) => [question.id, question]));
      setSession(created);
      setAnswers([]);
      setRecords([]);
      setSkippedCount(0);
      setSummary(null);
      setResumable(null);
      setDueAtStart(dueReviewConceptIds(context.masteryRows, new Date()));
      setOrdered(orderedIds.map((id) => byId.get(id)!));
      questionShownAt.current = Date.now();
      setError(null);
      setPhase({ name: 'question', index: 0, result: null });
    } catch {
      setError('We could not start the session. Please try again.');
      settle();
    }
  };

  /**
   * Continue a still-open session (M9 spec O): reload the persisted plan,
   * subtract the attempts already recorded and the explicit skips, and pick
   * up at the first remaining item. Mastery was already updated attempt by
   * attempt — nothing here re-submits or re-applies anything.
   */
  const resumeSession = async (target: StudySessionRow, poolArg: PracticeQuestionRow[]) => {
    const client = getSupabase();
    if (!client) return;
    try {
      const [context, planRows, priorAttempts] = await Promise.all([
        loadAdaptiveContext(client, poolArg),
        listSessionPlan(client, target.id),
        listSessionAttempts(client, target.id),
      ]);
      const byId = new Map(poolArg.map((question) => [question.id, question]));
      const answered = new Set(priorAttempts.map((attempt) => attempt.question_id));
      // Questions retired since the plan was written silently drop out.
      const remainingIds = remainingPlanQuestionIds(planRows, answered).filter((id) =>
        byId.has(id)
      );
      if (remainingIds.length === 0) {
        // Everything in the plan is done — close it out honestly.
        await closeStudySession(client, target.id, 'completed');
        setResumable(null);
        settle();
        return;
      }
      setRecords(
        priorAttempts.map((attempt) => ({
          questionId: attempt.question_id,
          conceptId: byId.get(attempt.question_id)?.concept_id ?? null,
          isCorrect: attempt.is_correct,
          masteryDelta: null,
        }))
      );
      setSkippedCount(planRows.filter((row) => row.skipped_at !== null).length);
      setAnswers([]);
      setSummary(null);
      setDueAtStart(dueReviewConceptIds(context.masteryRows, new Date()));
      setSession(target);
      setResumable(null);
      setOrdered(remainingIds.map((id) => byId.get(id)!));
      questionShownAt.current = Date.now();
      setError(null);
      setPhase({ name: 'question', index: 0, result: null });
    } catch {
      setError('We could not resume your session. You can start a new one below.');
      settle();
    }
  };

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) {
      settle();
      return;
    }
    try {
      const [c, questions] = await Promise.all([
        fetchOwnCourse(client, user.id, courseId),
        listActiveQuestions(client, courseId),
      ]);
      setCourse(c);
      setPool(questions);
      setError(c ? null : 'This course could not be found.');
      if (c && mode === 'adaptive') {
        let found: StudySessionRow | null = null;
        try {
          found = await findResumableSession(client, courseId);
        } catch {
          // Resume detection is best-effort; a fresh start always works.
        }
        setResumable(found);
        if (!autoLaunched.current) {
          if (found && resume) {
            autoLaunched.current = true;
            await resumeSession(found, questions);
            return;
          }
          if (!found && minutes !== null && questions.length > 0) {
            autoLaunched.current = true;
            await startAdaptiveSession(minutes, questions);
            return;
          }
          // An open session exists but a new one was requested: fall through
          // to setup so the student decides — progress is never discarded
          // silently (spec O).
        }
      }
      settle();
    } catch {
      setError('We could not load practice questions. Please try again.');
      settle();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, courseId, mode, minutes, resume, timeZone]);

  useFocusEffect(
    useCallback(() => {
      // Only (re)load while outside an active session so a focus change never
      // resets in-progress work.
      if (!session) {
        load();
      }
    }, [load, session])
  );

  const startSession = async (requested: number) => {
    const client = getSupabase();
    if (!client) return;
    const count = Math.min(requested, pool.length, MAX_SESSION_QUESTIONS);
    try {
      const created = await createStudySession(client, courseId, count, mode);
      // The session id seeds the deterministic order (M7 spec V/Z):
      // reproducible for this session, different for the next one.
      const orderedIds = buildSessionQuestionOrder(
        pool.map((question) => ({
          id: question.id,
          conceptId: question.concept_id,
          questionType: question.question_type,
          difficulty: question.difficulty,
        })),
        count,
        created.id
      ).map((item) => item.id);
      const byId = new Map(pool.map((question) => [question.id, question]));
      setSession(created);
      setAnswers([]);
      setRecords([]);
      setSkippedCount(0);
      setSummary(null);
      setOrdered(orderedIds.map((id) => byId.get(id)!));
      questionShownAt.current = Date.now();
      setPhase({ name: 'question', index: 0, result: null });
    } catch {
      setError('We could not start the session. Please try again.');
    }
  };

  const onSubmitAnswer = async (
    question: PracticeQuestionRow,
    response: AttemptResponse,
    confidence: ConfidenceLevel | null
  ) => {
    const client = getSupabase();
    if (!client || !session || phase.name !== 'question') return;
    try {
      const result = await submitAttempt(
        client,
        session.id,
        question.id,
        response,
        Math.max(0, Date.now() - questionShownAt.current),
        confidence
      );
      setAnswers((previous) => [...previous, { question, result, confidence }]);
      setRecords((previous) => [
        ...previous,
        {
          questionId: question.id,
          conceptId: question.concept_id,
          isCorrect: result.is_correct,
          masteryDelta: result.mastery?.mastery_delta ?? null,
        },
      ]);
      if (mode === 'adaptive') {
        // Spec C/J: fold the SERVER's post-update aggregate into the local
        // rows, re-rank with the pure engine, and re-order what is still
        // ahead. The stored plan stays untouched as the resume baseline.
        const answeredAt = new Date().toISOString();
        const nextMastery = result.mastery
          ? applyMasteryEcho(masteryRows, result.mastery, answeredAt)
          : masteryRows;
        const nextAttempts = appendLocalAttempt(
          attempts,
          question.id,
          result.is_correct,
          answeredAt
        );
        const nextRanked = rankConcepts({
          concepts: buildConceptSnapshots(conceptRows, pool, nextMastery, nextAttempts),
          exams: toUpcomingExams(exams),
          timeZone,
          now: new Date(),
        });
        setMasteryRows(nextMastery);
        setAttempts(nextAttempts);
        setRanked(nextRanked);
        const upcoming = ordered.slice(phase.index + 1);
        if (upcoming.length > 1) {
          const seen = seenQuestionIds(nextAttempts);
          const reorderedIds = reorderRemainingQuestions(
            upcoming.map(toSelectable(seen)),
            nextRanked,
            session.id,
            answers.length + 1
          );
          const byId = new Map(upcoming.map((item) => [item.id, item]));
          setOrdered([
            ...ordered.slice(0, phase.index + 1),
            ...reorderedIds.map((id) => byId.get(id)!),
          ]);
        }
      }
      setPhase({ name: 'question', index: phase.index, result });
      setError(null);
    } catch {
      setError('We could not submit your answer. Please try again.');
    }
  };

  /** Close the session and, in adaptive mode, build the honest summary. */
  const finishSession = async (dbStatus: 'completed' | 'abandoned', reachedEnd: boolean) => {
    const client = getSupabase();
    if (client && session) {
      try {
        await closeStudySession(client, session.id, dbStatus);
      } catch {
        // The results still render; the row stays recoverable server-side.
      }
    }
    if (mode === 'adaptive') {
      if (reachedEnd) {
        trackEvent({
          name: 'daily_session_completed',
          answeredCount: records.length,
          skippedCount,
        });
      } else {
        trackEvent({ name: 'daily_session_abandoned', answeredCount: records.length });
      }
      setSummary(
        buildSessionSummary({
          records,
          skippedCount,
          dueConceptIdsAtStart: dueAtStart,
          latestRanked: ranked,
        })
      );
    }
    setSession(null);
  };

  const onNext = async () => {
    if (phase.name !== 'question') return;
    const nextIndex = phase.index + 1;
    if (nextIndex >= ordered.length) {
      await finishSession('completed', true);
      setPhase({ name: 'results' });
      return;
    }
    questionShownAt.current = Date.now();
    setPhase({ name: 'question', index: nextIndex, result: null });
  };

  const onEndEarly = async () => {
    const hadAnswers = answers.length > 0 || records.length > 0;
    await finishSession(hadAnswers ? 'completed' : 'abandoned', false);
    setPhase(hadAnswers ? { name: 'results' } : { name: 'setup' });
  };

  /**
   * Skip (M9 spec AB): recorded explicitly on the plan row — neither correct
   * nor incorrect, and mastery is never touched. Available only before an
   * answer is locked in.
   */
  const onSkip = async () => {
    if (phase.name !== 'question' || phase.result !== null || !session) return;
    const question = ordered[phase.index]!;
    const client = getSupabase();
    if (client) {
      try {
        await markPlanSkipped(client, session.id, question.id);
      } catch {
        // The skip still applies locally; only the stored marker is missing.
      }
    }
    setSkippedCount((count) => count + 1);
    if (phase.index + 1 >= ordered.length) {
      const hadAnswers = records.length > 0;
      await finishSession(hadAnswers ? 'completed' : 'abandoned', hadAnswers);
      setPhase(hadAnswers ? { name: 'results' } : { name: 'setup' });
      return;
    }
    questionShownAt.current = Date.now();
    setPhase({ name: 'question', index: phase.index + 1, result: null });
  };

  const modeTitle = mode === 'adaptive' ? 'Adaptive study' : 'Practice';

  if (phase.name === 'loading') {
    return (
      <Screen title={modeTitle}>
        <Text style={styles.muted}>Loading practice questions…</Text>
      </Screen>
    );
  }

  if (!course) {
    return (
      <Screen title={modeTitle}>
        <ErrorBanner message={error} />
        <SecondaryButton label="Retry" onPress={load} />
        <SecondaryButton label="Back to courses" onPress={() => router.replace('/courses')} />
      </Screen>
    );
  }

  if (phase.name === 'setup') {
    return (
      <Screen title={`${modeTitle} — ${course.title}`}>
        <ErrorBanner message={error} />
        {error ? <SecondaryButton label="Retry" onPress={load} /> : null}
        {pool.length === 0 ? (
          <>
            <Text style={styles.muted}>
              No practice questions yet. Questions are created automatically from your uploaded
              materials once they finish processing — check back after your materials are ready.
            </Text>
            <SecondaryButton
              label="Back to course"
              onPress={() => router.push(`/course/${courseId}`)}
            />
          </>
        ) : (
          <>
            {mode === 'adaptive' && resumable ? (
              <View style={styles.resumeCard}>
                <Text style={styles.resumeHeading}>You have a session in progress</Text>
                <Text style={styles.muted}>
                  Continue where you left off — answered questions are already saved.
                </Text>
                <PrimaryButton
                  label="Continue session"
                  onPress={() => resumeSession(resumable, pool)}
                />
                <SecondaryButton
                  label="Start a new session instead"
                  onPress={async () => {
                    const client = getSupabase();
                    if (client) {
                      try {
                        await closeStudySession(client, resumable.id, 'abandoned');
                      } catch {
                        // Best effort; the new session is independent anyway.
                      }
                    }
                    setResumable(null);
                  }}
                />
              </View>
            ) : null}
            <Text style={styles.intro}>
              {pool.length} question{pool.length === 1 ? '' : 's'} available from your course
              materials. Choose a session length —{' '}
              {mode === 'adaptive'
                ? 'questions are picked for the topics that most need your attention right now.'
                : 'questions are mixed across the topics your materials cover.'}
            </Text>
            {mode === 'adaptive' ? (
              <View style={styles.choiceRow}>
                {SESSION_DURATION_MINUTES.map((duration) => (
                  <PrimaryButton
                    key={duration}
                    label={`${duration} min`}
                    onPress={() => startAdaptiveSession(duration, pool)}
                  />
                ))}
              </View>
            ) : (
              <View style={styles.choiceRow}>
                {SESSION_SIZE_CHOICES.filter(
                  (size, index) => size <= pool.length || index === 0
                ).map((size) => (
                  <PrimaryButton
                    key={size}
                    label={`${Math.min(size, pool.length)} questions`}
                    onPress={() => startSession(size)}
                  />
                ))}
              </View>
            )}
            <SecondaryButton
              label="Back to course"
              onPress={() => router.push(`/course/${courseId}`)}
            />
          </>
        )}
      </Screen>
    );
  }

  if (phase.name === 'results') {
    const correct = answers.filter((answer) => answer.result.is_correct).length;
    return (
      <Screen title="Session results">
        {mode === 'adaptive' && summary ? (
          <View style={styles.summaryCard}>
            <Text style={styles.scoreLine}>
              You completed {summary.answeredCount}{' '}
              {summary.answeredCount === 1 ? 'activity' : 'activities'} — {summary.correctCount}{' '}
              correct.
            </Text>
            {summary.skippedCount > 0 ? (
              <Text style={styles.meta}>
                Skipped: {summary.skippedCount} (skips never count against you)
              </Text>
            ) : null}
            {summary.conceptsReviewed.length > 0 ? (
              <Text style={styles.summaryLine}>
                Concepts reviewed:{' '}
                {summary.conceptsReviewed
                  .map((id) => conceptNames.get(id) ?? 'Course material')
                  .join(', ')}
              </Text>
            ) : null}
            {summary.conceptsImproved.length > 0 ? (
              <Text style={styles.summaryLine}>
                Moving forward:{' '}
                {summary.conceptsImproved
                  .map((id) => conceptNames.get(id) ?? 'Course material')
                  .join(', ')}
              </Text>
            ) : null}
            {summary.dueReviewsCompleted > 0 ? (
              <Text style={styles.summaryLine}>
                Due reviews completed: {summary.dueReviewsCompleted}
              </Text>
            ) : null}
            {summary.remainingPriorities.length > 0 ? (
              <Text style={styles.summaryLine}>
                Still waiting:{' '}
                {summary.remainingPriorities
                  .map((rec) => conceptNames.get(rec.conceptId) ?? 'Course material')
                  .join(', ')}
              </Text>
            ) : null}
            {summary.recommendedNext ? (
              <Text style={styles.summaryNext}>
                Recommended next:{' '}
                {conceptNames.get(summary.recommendedNext.conceptId) ?? 'Course material'} (
                {MASTERY_STATE_LABELS[summary.recommendedNext.masteryState]})
              </Text>
            ) : null}
          </View>
        ) : (
          <Text style={styles.scoreLine}>
            You answered {correct} of {answers.length} correctly.
          </Text>
        )}
        {answers.map((answer, index) => (
          <View key={answer.question.id} style={styles.resultCard}>
            <Text style={styles.resultVerdict}>
              {index + 1}. {answer.result.is_correct ? 'Correct' : 'Incorrect'}
            </Text>
            <Text style={styles.stemSmall}>{answer.question.stem}</Text>
            {answer.confidence ? (
              <Text style={styles.meta}>
                Your confidence: {CONFIDENCE_LEVEL_LABELS[answer.confidence]}
              </Text>
            ) : null}
          </View>
        ))}
        <PrimaryButton
          label={mode === 'adaptive' ? 'Study again' : 'Practice again'}
          onPress={() => setPhase({ name: 'setup' })}
        />
        <SecondaryButton
          label={mode === 'adaptive' ? 'Back to Today' : 'Back to course'}
          onPress={() =>
            mode === 'adaptive' ? router.push('/home') : router.push(`/course/${courseId}`)
          }
        />
      </Screen>
    );
  }

  const question = ordered[phase.index]!;
  // M9 spec H: why this question, from the deterministic reason codes.
  const recommendation =
    mode === 'adaptive' && question.concept_id !== null
      ? ranked.find((rec) => rec.conceptId === question.concept_id)
      : undefined;
  const remainingAfterThis = ordered.length - phase.index - (phase.result ? 1 : 0);
  const minutesLeft = estimateRemainingMinutes(remainingAfterThis);
  return (
    <Screen title={`Question ${phase.index + 1} of ${ordered.length}`}>
      <ErrorBanner message={error} />
      {mode === 'adaptive' && minutesLeft > 0 ? (
        <Text style={styles.progressLine}>~{minutesLeft} min left</Text>
      ) : null}
      {recommendation ? (
        <View style={styles.whyPanel}>
          <Text style={styles.whyHeading}>
            Why this: {conceptNames.get(recommendation.conceptId) ?? 'Course material'}
          </Text>
          <Text style={styles.whyReasons}>
            {recommendation.reasonCodes
              .slice(0, 2)
              .map((reason) => RECOMMENDATION_REASON_LABELS[reason])
              .join(' · ')}
          </Text>
          {hasActiveMisconceptionFactor(recommendation) ? (
            <Text style={styles.whyReasons}>{MISCONCEPTION_REVISIT_MESSAGE}</Text>
          ) : null}
        </View>
      ) : null}
      <QuestionCard
        key={question.id}
        question={question}
        result={phase.result}
        concise={mode === 'adaptive'}
        onExplainMore={() => trackEvent({ name: 'explain_more_used' })}
        onSubmit={(response, confidence) => onSubmitAnswer(question, response, confidence)}
      />
      {mode === 'adaptive' && phase.result ? <SourceRefsPanel questionId={question.id} /> : null}
      {phase.result ? <FlagQuestionPanel questionId={question.id} courseId={courseId} /> : null}
      {phase.result ? (
        <PrimaryButton
          label={phase.index + 1 >= ordered.length ? 'See results' : 'Next question'}
          onPress={onNext}
        />
      ) : mode === 'adaptive' ? (
        <SecondaryButton label="Skip for now" onPress={onSkip} />
      ) : null}
      <SecondaryButton label="End session" onPress={onEndEarly} />
    </Screen>
  );
}

/** Human-readable source line (M9 spec T): filename + slide/page — never ids. */
export function formatSourceRef(ref: QuestionSourceRef): string {
  const locator = (ref.source_locator ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof locator.slide === 'number') parts.push(`Slide ${locator.slide}`);
  if (typeof locator.page === 'number') parts.push(`Page ${locator.page}`);
  if (typeof locator.section === 'string' && locator.section.length > 0) {
    parts.push(locator.section);
  }
  if (typeof locator.title === 'string' && locator.title.length > 0) {
    parts.push(`“${locator.title}”`);
  }
  return parts.length > 0
    ? `${ref.document_filename} — ${parts.join(', ')}`
    : ref.document_filename;
}

/**
 * "View source" (M9 spec T/G): where the question came from, in student
 * terms (document + slide/page). Loaded on demand; chunk ids and retrieval
 * scores are never shown (the grants don't even allow reading them).
 */
function SourceRefsPanel({ questionId }: { questionId: string }) {
  const [open, setOpen] = useState(false);
  const [refs, setRefs] = useState<QuestionSourceRef[] | null>(null);
  const [failed, setFailed] = useState(false);

  if (!open) {
    return (
      <SecondaryButton
        label="View source"
        onPress={async () => {
          setOpen(true);
          trackEvent({ name: 'source_viewed' });
          const client = getSupabase();
          if (!client) {
            setFailed(true);
            return;
          }
          try {
            setRefs(await listQuestionSourceRefs(client, questionId));
          } catch {
            setFailed(true);
          }
        }}
      />
    );
  }
  if (failed) {
    return (
      <Text style={styles.sourceLine}>The source reference could not be loaded right now.</Text>
    );
  }
  if (refs === null) {
    return <Text style={styles.sourceLine}>Loading source…</Text>;
  }
  if (refs.length === 0) {
    return (
      <Text style={styles.sourceLine}>
        No stored source location for this question — it was generated from your course material as
        a whole.
      </Text>
    );
  }
  return (
    <View style={styles.sourcePanel}>
      {refs.map((ref, index) => (
        <Text key={index} style={styles.sourceLine}>
          Based on: {formatSourceRef(ref)}
        </Text>
      ))}
    </View>
  );
}

/**
 * Rationale display (M9 spec G): concise first, full text behind "Explain
 * more". The full rationale is always available — nothing is withheld.
 */
function RationaleText({
  text,
  concise,
  onExplainMore,
}: {
  text: string;
  concise: boolean;
  onExplainMore?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const boundary = text.search(/[.!?](\s|$)/);
  const firstSentence = boundary >= 0 ? text.slice(0, boundary + 1) : text;
  const hasMore = concise && !expanded && firstSentence.trim().length < text.trim().length;
  if (!hasMore) {
    return <Text style={styles.rationale}>{text}</Text>;
  }
  return (
    <View style={styles.rationaleBlock}>
      <Text style={styles.rationale}>{firstSentence}</Text>
      <SecondaryButton
        label="Explain more"
        onPress={() => {
          setExpanded(true);
          onExplainMore?.();
        }}
      />
    </View>
  );
}

/** One question with its type-appropriate interaction and revealed feedback. */
function QuestionCard({
  question,
  result,
  concise = false,
  onExplainMore,
  onSubmit,
}: {
  question: PracticeQuestionRow;
  result: AttemptResult | null;
  concise?: boolean;
  onExplainMore?: () => void;
  onSubmit: (response: AttemptResponse, confidence: ConfidenceLevel | null) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [orderedIds, setOrderedIds] = useState<string[]>([]);
  const [numericText, setNumericText] = useState('');
  const [confidence, setConfidence] = useState<ConfidenceLevel | null>(null);
  const locked = result !== null;

  const revealedById = useMemo(
    () => new Map((result?.options ?? []).map((option) => [option.id, option])),
    [result]
  );

  const toggleChoice = (optionId: string) => {
    if (locked) return;
    if (question.question_type === 'single_best_answer') {
      setSelectedIds([optionId]);
    } else if (question.question_type === 'multiple_response') {
      setSelectedIds((previous) =>
        previous.includes(optionId)
          ? previous.filter((id) => id !== optionId)
          : [...previous, optionId]
      );
    } else if (question.question_type === 'ordered_response') {
      setOrderedIds((previous) =>
        previous.includes(optionId) ? previous : [...previous, optionId]
      );
    }
  };

  const numericValue = Number(numericText.replace(',', '.'));
  const canSubmit =
    !locked &&
    (question.question_type === 'single_best_answer'
      ? selectedIds.length === 1
      : question.question_type === 'multiple_response'
        ? selectedIds.length >= 1
        : question.question_type === 'ordered_response'
          ? orderedIds.length === question.options.length
          : numericText.trim().length > 0 && Number.isFinite(numericValue));

  const submit = () => {
    if (!canSubmit) return;
    const response: AttemptResponse =
      question.question_type === 'numeric_calculation'
        ? { value: numericValue }
        : question.question_type === 'ordered_response'
          ? { ordered_option_ids: orderedIds }
          : { selected_option_ids: selectedIds };
    onSubmit(response, confidence);
  };

  return (
    <View style={styles.questionCard}>
      <View style={styles.badgeRow}>
        <Text style={styles.typeBadge}>{QUESTION_TYPE_LABELS[question.question_type]}</Text>
        <Text style={styles.sourceBadge}>{QUESTION_SOURCE_TYPE_LABELS[question.source_type]}</Text>
      </View>
      <Text style={styles.stem}>{question.stem}</Text>

      {question.question_type === 'numeric_calculation' ? (
        <TextInput
          value={numericText}
          onChangeText={setNumericText}
          editable={!locked}
          keyboardType="numeric"
          placeholder="Your answer"
          placeholderTextColor={colors.textMuted}
          style={styles.numericInput}
          accessibilityLabel="Your numeric answer"
        />
      ) : (
        question.options.map((option) => {
          const revealed = revealedById.get(option.id);
          const picked =
            question.question_type === 'ordered_response'
              ? orderedIds.includes(option.id)
              : selectedIds.includes(option.id);
          const orderNumber =
            question.question_type === 'ordered_response' && picked
              ? orderedIds.indexOf(option.id) + 1
              : null;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityLabel={`Option: ${option.option_text}`}
              disabled={locked}
              onPress={() => toggleChoice(option.id)}
              style={[
                styles.option,
                picked && !locked && styles.optionPicked,
                revealed?.is_correct === true && styles.optionCorrect,
                locked && picked && revealed?.is_correct === false && styles.optionWrongPick,
              ]}
            >
              <Text style={styles.optionText}>
                {orderNumber ? `${orderNumber}. ` : ''}
                {option.option_text}
              </Text>
              {locked && revealed ? (
                <Text style={styles.optionVerdict}>
                  {question.question_type === 'ordered_response'
                    ? `Correct position: ${revealed.correct_position}`
                    : revealed.is_correct
                      ? 'Correct answer'
                      : picked
                        ? 'Your pick — incorrect'
                        : ''}
                  {revealed.rationale ? ` — ${revealed.rationale}` : ''}
                </Text>
              ) : null}
            </Pressable>
          );
        })
      )}

      {question.question_type === 'ordered_response' && !locked && orderedIds.length > 0 ? (
        <SecondaryButton label="Reset order" onPress={() => setOrderedIds([])} />
      ) : null}

      {!locked ? (
        <View style={styles.confidenceRow}>
          <Text style={styles.confidenceLabel}>How sure are you? (optional)</Text>
          <View style={styles.choiceRow}>
            {CONFIDENCE_LEVELS.map((level) => (
              <Pressable
                key={level}
                accessibilityRole="button"
                accessibilityLabel={`Confidence: ${CONFIDENCE_LEVEL_LABELS[level]}`}
                onPress={() => setConfidence(confidence === level ? null : level)}
                style={[styles.confidenceChip, confidence === level && styles.confidenceChipOn]}
              >
                <Text
                  style={[
                    styles.confidenceChipLabel,
                    confidence === level && styles.confidenceChipLabelOn,
                  ]}
                >
                  {CONFIDENCE_LEVEL_LABELS[level]}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {!locked ? (
        <PrimaryButton label="Submit answer" onPress={submit} disabled={!canSubmit} />
      ) : (
        <View style={styles.resultPanel}>
          <Text style={result.is_correct ? styles.verdictCorrect : styles.verdictIncorrect}>
            {result.is_correct ? 'Correct' : 'Incorrect'}
          </Text>
          {question.question_type === 'numeric_calculation' && result.expected_value !== null ? (
            <Text style={styles.expected}>
              Expected: {result.expected_value}
              {result.answer_unit ? ` ${result.answer_unit}` : ''}
              {result.tolerance ? ` (±${result.tolerance})` : ''}
              {result.rounding_note ? ` — ${result.rounding_note}` : ''}
            </Text>
          ) : null}
          <RationaleText text={result.rationale} concise={concise} onExplainMore={onExplainMore} />
        </View>
      )}
    </View>
  );
}

/**
 * Student flagging (spec AH): reporting a problem records a review request —
 * it never changes the question or its answer.
 */
function FlagQuestionPanel({ questionId, courseId }: { questionId: string; courseId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<QuestionFeedbackReason | null>(null);
  const [comment, setComment] = useState('');
  const [done, setDone] = useState(false);
  const [flagError, setFlagError] = useState<string | null>(null);

  if (done) {
    return (
      <Text style={styles.flagThanks}>
        Thanks — this question has been flagged for review. Your report never changes the answer by
        itself; it queues the question for a careful look.
      </Text>
    );
  }
  if (!open) {
    return <SecondaryButton label="Report a problem" onPress={() => setOpen(true)} />;
  }

  const send = async () => {
    const client = getSupabase();
    if (!client || !reason) return;
    try {
      await submitQuestionFeedback(client, questionId, courseId, reason, comment);
      setDone(true);
      setFlagError(null);
    } catch {
      setFlagError('We could not send the report. Please try again.');
    }
  };

  return (
    <View style={styles.flagPanel}>
      <ErrorBanner message={flagError} />
      <Text style={styles.confidenceLabel}>What seems wrong?</Text>
      <View style={styles.choiceRow}>
        {QUESTION_FEEDBACK_REASONS.map((value) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityLabel={`Reason: ${QUESTION_FEEDBACK_REASON_LABELS[value]}`}
            onPress={() => setReason(value)}
            style={[styles.confidenceChip, reason === value && styles.confidenceChipOn]}
          >
            <Text
              style={[styles.confidenceChipLabel, reason === value && styles.confidenceChipLabelOn]}
            >
              {QUESTION_FEEDBACK_REASON_LABELS[value]}
            </Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        value={comment}
        onChangeText={setComment}
        placeholder="Anything else we should know? (optional)"
        placeholderTextColor={colors.textMuted}
        style={styles.numericInput}
        accessibilityLabel="Report details"
      />
      <View style={styles.choiceRow}>
        <SecondaryButton label="Cancel" onPress={() => setOpen(false)} />
        <PrimaryButton label="Send report" onPress={send} disabled={!reason} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted, fontSize: 15, lineHeight: 22 },
  intro: { color: colors.textMuted, fontSize: 14, lineHeight: 20, marginBottom: spacing(3) },
  meta: { color: colors.textMuted, fontSize: 13 },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2), alignItems: 'center' },
  progressLine: { color: colors.textMuted, fontSize: 13, marginBottom: spacing(2) },
  whyPanel: {
    backgroundColor: colors.badge,
    borderRadius: 10,
    padding: spacing(3),
    marginBottom: spacing(3),
    gap: spacing(1),
  },
  whyHeading: { color: colors.badgeText, fontWeight: '600', fontSize: 13 },
  whyReasons: { color: colors.badgeText, fontSize: 13, lineHeight: 18 },
  resumeCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(4),
    gap: spacing(2),
    marginBottom: spacing(4),
  },
  resumeHeading: { color: colors.text, fontWeight: '600', fontSize: 16 },
  summaryCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(4),
    gap: spacing(2),
    marginBottom: spacing(4),
  },
  summaryLine: { color: colors.text, fontSize: 14, lineHeight: 20 },
  summaryNext: { color: colors.primary, fontSize: 14, fontWeight: '600', lineHeight: 20 },
  sourcePanel: { gap: spacing(1), marginBottom: spacing(2) },
  sourceLine: { color: colors.textMuted, fontSize: 13, lineHeight: 18, marginBottom: spacing(2) },
  rationaleBlock: { gap: spacing(2) },
  questionCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(4),
    gap: spacing(3),
    marginBottom: spacing(3),
  },
  badgeRow: { flexDirection: 'row', gap: spacing(2), flexWrap: 'wrap' },
  typeBadge: { fontSize: 13, color: colors.primary, fontWeight: '600' },
  sourceBadge: { fontSize: 13, color: colors.textMuted },
  stem: { fontSize: 16, color: colors.text, lineHeight: 24 },
  stemSmall: { fontSize: 14, color: colors.text, lineHeight: 20 },
  option: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: spacing(3),
    gap: spacing(1),
  },
  optionPicked: { borderColor: colors.primary, backgroundColor: colors.background },
  optionCorrect: { borderColor: '#16a34a', backgroundColor: '#f0fdf4' },
  optionWrongPick: { borderColor: colors.danger, backgroundColor: '#fef2f2' },
  optionText: { fontSize: 15, color: colors.text, lineHeight: 21 },
  optionVerdict: { fontSize: 13, color: colors.textMuted, lineHeight: 18 },
  numericInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2.5),
    fontSize: 15,
    color: colors.text,
  },
  confidenceRow: { gap: spacing(2) },
  confidenceLabel: { fontSize: 13, fontWeight: '600', color: colors.text },
  confidenceChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(1.5),
  },
  confidenceChipOn: { borderColor: colors.primary, backgroundColor: colors.background },
  confidenceChipLabel: { fontSize: 13, color: colors.textMuted },
  confidenceChipLabelOn: { color: colors.primary, fontWeight: '600' },
  resultPanel: { gap: spacing(2) },
  verdictCorrect: { fontSize: 16, fontWeight: '700', color: '#16a34a' },
  verdictIncorrect: { fontSize: 16, fontWeight: '700', color: colors.danger },
  expected: { fontSize: 14, color: colors.text, fontWeight: '600' },
  rationale: { fontSize: 14, color: colors.text, lineHeight: 21 },
  scoreLine: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: spacing(3) },
  resultCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(3),
    gap: spacing(1),
    marginBottom: spacing(2),
  },
  resultVerdict: { fontSize: 14, fontWeight: '700', color: colors.text },
  flagPanel: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(3),
    gap: spacing(2),
    marginBottom: spacing(3),
  },
  flagThanks: { fontSize: 13, color: colors.textMuted, lineHeight: 19, marginBottom: spacing(2) },
});
