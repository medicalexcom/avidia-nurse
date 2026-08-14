import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { buildSessionQuestionOrder } from '@avidia/assessment/src/mix';
import {
  CONFIDENCE_LEVELS,
  CONFIDENCE_LEVEL_LABELS,
  QUESTION_FEEDBACK_REASONS,
  QUESTION_FEEDBACK_REASON_LABELS,
  QUESTION_SOURCE_TYPE_LABELS,
  QUESTION_TYPE_LABELS,
  type ConfidenceLevel,
  type QuestionFeedbackReason,
} from '@avidia/domain';

import { useAuth } from '../../auth/AuthProvider';
import { getSupabase } from '../../../lib/supabase';
import { ErrorBanner, PrimaryButton, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import { fetchOwnCourse, type Course } from '../../courses/coursesApi';
import {
  closeStudySession,
  createStudySession,
  listActiveQuestions,
  submitAttempt,
  submitQuestionFeedback,
  type AttemptResponse,
  type AttemptResult,
  type PracticeQuestionRow,
  type StudySessionRow,
} from '../practiceApi';

/**
 * Practice session flow (M7 spec V/W/X/U/AH). Deliberately basic and honest:
 *
 *   setup → one question at a time → locked answer + rationale → results
 *
 * Selection is deterministic-random, balanced across concepts, and NOT
 * adaptive (spec V/Z/AL): the session id seeds the mix, so refreshing cannot
 * reshuffle answered questions. Answers are immutable once submitted (spec W)
 * — there is no "change answer", and the correct answer plus rationales exist
 * client-side only after the server has locked the attempt in. Results are a
 * plain score with per-question review, with no mastery or weakness labels
 * (spec X/AL).
 */

const SESSION_SIZE_CHOICES = [5, 10, 20];
export const MAX_SESSION_QUESTIONS = 50;

interface AnsweredQuestion {
  question: PracticeQuestionRow;
  result: AttemptResult;
  confidence: ConfidenceLevel | null;
}

type Phase =
  | { name: 'loading' }
  | { name: 'setup' }
  | { name: 'question'; index: number; result: AttemptResult | null }
  | { name: 'results' };

export function PracticeScreen({ courseId }: { courseId: string }) {
  const { user } = useAuth();
  const [course, setCourse] = useState<Course | null>(null);
  const [pool, setPool] = useState<PracticeQuestionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [session, setSession] = useState<StudySessionRow | null>(null);
  const [ordered, setOrdered] = useState<PracticeQuestionRow[]>([]);
  const [answers, setAnswers] = useState<AnsweredQuestion[]>([]);
  const questionShownAt = useRef<number>(Date.now());

  // Move to setup only from loading/setup — never clobber an active question
  // or the results view when focus returns to the screen.
  const settle = () =>
    setPhase((previous) =>
      previous.name === 'loading' || previous.name === 'setup' ? { name: 'setup' } : previous
    );

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
      settle();
    } catch {
      setError('We could not load practice questions. Please try again.');
      settle();
    }
  }, [user, courseId]);

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
      const created = await createStudySession(client, courseId, count);
      // The session id seeds the deterministic mix (spec V/Z): reproducible
      // for this session, different for the next one.
      const mixed = buildSessionQuestionOrder(
        pool.map((question) => ({
          id: question.id,
          conceptId: question.concept_id,
          questionType: question.question_type,
          difficulty: question.difficulty,
        })),
        count,
        created.id
      );
      const byId = new Map(pool.map((question) => [question.id, question]));
      setSession(created);
      setAnswers([]);
      setOrdered(mixed.map((item) => byId.get(item.id)!));
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
      setPhase({ name: 'question', index: phase.index, result });
      setError(null);
    } catch {
      setError('We could not submit your answer. Please try again.');
    }
  };

  const onNext = async () => {
    if (phase.name !== 'question') return;
    const nextIndex = phase.index + 1;
    if (nextIndex >= ordered.length) {
      const client = getSupabase();
      if (client && session) {
        try {
          await closeStudySession(client, session.id, 'completed');
        } catch {
          // The results still render; the row stays recoverable server-side.
        }
      }
      setSession(null);
      setPhase({ name: 'results' });
      return;
    }
    questionShownAt.current = Date.now();
    setPhase({ name: 'question', index: nextIndex, result: null });
  };

  const onEndEarly = async () => {
    const client = getSupabase();
    if (client && session) {
      try {
        await closeStudySession(client, session.id, answers.length > 0 ? 'completed' : 'abandoned');
      } catch {
        // Non-fatal; see above.
      }
    }
    setSession(null);
    setPhase(answers.length > 0 ? { name: 'results' } : { name: 'setup' });
  };

  if (phase.name === 'loading') {
    return (
      <Screen title="Practice">
        <Text style={styles.muted}>Loading practice questions…</Text>
      </Screen>
    );
  }

  if (!course) {
    return (
      <Screen title="Practice">
        <ErrorBanner message={error} />
        <SecondaryButton label="Retry" onPress={load} />
        <SecondaryButton label="Back to courses" onPress={() => router.replace('/courses')} />
      </Screen>
    );
  }

  if (phase.name === 'setup') {
    return (
      <Screen title={`Practice — ${course.title}`}>
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
            <Text style={styles.intro}>
              {pool.length} question{pool.length === 1 ? '' : 's'} available from your course
              materials. Choose a session length — questions are mixed across the topics your
              materials cover.
            </Text>
            <View style={styles.choiceRow}>
              {SESSION_SIZE_CHOICES.filter((size, index) => size <= pool.length || index === 0).map(
                (size) => (
                  <PrimaryButton
                    key={size}
                    label={`${Math.min(size, pool.length)} questions`}
                    onPress={() => startSession(size)}
                  />
                )
              )}
            </View>
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
        <Text style={styles.scoreLine}>
          You answered {correct} of {answers.length} correctly.
        </Text>
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
        <PrimaryButton label="Practice again" onPress={() => setPhase({ name: 'setup' })} />
        <SecondaryButton
          label="Back to course"
          onPress={() => router.push(`/course/${courseId}`)}
        />
      </Screen>
    );
  }

  const question = ordered[phase.index]!;
  return (
    <Screen title={`Question ${phase.index + 1} of ${ordered.length}`}>
      <ErrorBanner message={error} />
      <QuestionCard
        key={question.id}
        question={question}
        result={phase.result}
        onSubmit={(response, confidence) => onSubmitAnswer(question, response, confidence)}
      />
      {phase.result ? <FlagQuestionPanel questionId={question.id} courseId={courseId} /> : null}
      {phase.result ? (
        <PrimaryButton
          label={phase.index + 1 >= ordered.length ? 'See results' : 'Next question'}
          onPress={onNext}
        />
      ) : null}
      <SecondaryButton label="End session" onPress={onEndEarly} />
    </Screen>
  );
}

/** One question with its type-appropriate interaction and revealed feedback. */
function QuestionCard({
  question,
  result,
  onSubmit,
}: {
  question: PracticeQuestionRow;
  result: AttemptResult | null;
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
          <Text style={styles.rationale}>{result.rationale}</Text>
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
