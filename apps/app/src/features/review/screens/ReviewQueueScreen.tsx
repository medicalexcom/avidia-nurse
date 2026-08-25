import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import {
  COGNITIVE_LEVEL_LABELS,
  QUESTION_DIFFICULTY_LABELS,
  QUESTION_TYPE_LABELS,
} from '@avidia/domain';

import { getSupabase } from '../../../lib/supabase';
import {
  ErrorBanner,
  Field,
  Pill,
  PrimaryButton,
  Screen,
  SecondaryButton,
  SectionIcon,
} from '../../../ui/components';
import { colors, radius, sectionAccents, shadow, spacing, type } from '../../../ui/theme';
import {
  decideReviewQuestion,
  fetchReviewQueue,
  type ReviewApiError,
  type ReviewEdits,
  type ReviewQuestion,
} from '../reviewApi';

type LoadState = 'loading' | 'ok' | 'forbidden' | 'error';

export function ReviewQueueScreen() {
  const [questions, setQuestions] = useState<ReviewQuestion[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client) {
      setState('error');
      setErrorMessage('Content review is not available right now.');
      return;
    }
    setState('loading');
    try {
      const data = await fetchReviewQueue(client);
      setQuestions(data);
      setState('ok');
      setErrorMessage(null);
    } catch (err) {
      const apiErr = err as ReviewApiError;
      setState(apiErr.status === 403 ? 'forbidden' : 'error');
      setErrorMessage(apiErr.message ?? 'Content review is unavailable right now.');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // A question leaves the queue the moment it's decided — remove it locally
  // rather than re-fetching, so the list doesn't jump around mid-review.
  const onDecided = useCallback((questionId: string) => {
    setQuestions((prev) => prev.filter((q) => q.id !== questionId));
  }, []);

  return (
    <Screen title="Content review">
      {state === 'loading' ? <Text style={styles.muted}>Loading the review queue…</Text> : null}

      {state === 'forbidden' ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Reviewer access required</Text>
          <Text style={styles.muted}>{errorMessage}</Text>
        </View>
      ) : null}

      {state === 'error' ? (
        <>
          <ErrorBanner message={errorMessage} />
          <SecondaryButton label="Retry" onPress={load} />
        </>
      ) : null}

      {state === 'ok' && questions.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Queue is empty</Text>
          <Text style={styles.muted}>
            Nothing is waiting for review right now — generated and flagged questions will show up
            here.
          </Text>
        </View>
      ) : null}

      {state === 'ok' && questions.length > 0 ? (
        <View style={styles.list}>
          <Text style={styles.muted}>
            {questions.length} question{questions.length === 1 ? '' : 's'} waiting for review,
            oldest first.
          </Text>
          {questions.map((q) => (
            <ReviewQuestionCard key={q.id} question={q} onDecided={onDecided} />
          ))}
        </View>
      ) : null}
    </Screen>
  );
}

interface EditableOption {
  id: string;
  option_text: string;
  rationale: string;
  is_correct: boolean;
  ordinal: number;
}

function ReviewQuestionCard({
  question,
  onDecided,
}: {
  question: ReviewQuestion;
  onDecided: (questionId: string) => void;
}) {
  const [stem, setStem] = useState(question.stem);
  const [rationale, setRationale] = useState(question.rationale);
  const [options, setOptions] = useState<EditableOption[]>(
    question.question_options.map((o) => ({
      id: o.id,
      option_text: o.option_text,
      rationale: o.rationale ?? '',
      is_correct: o.is_correct,
      ordinal: o.ordinal,
    }))
  );
  const [busy, setBusy] = useState<'save' | 'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const buildEdits = (): ReviewEdits | undefined => {
    const edits: ReviewEdits = {};
    if (stem !== question.stem) edits.stem = stem;
    if (rationale !== question.rationale) edits.rationale = rationale;
    const optionEdits = options
      .map((o) => {
        const original = question.question_options.find((orig) => orig.id === o.id);
        const patch: { id: string; option_text?: string; rationale?: string | null } = { id: o.id };
        let changed = false;
        if (original && o.option_text !== original.option_text) {
          patch.option_text = o.option_text;
          changed = true;
        }
        if (original && o.rationale !== (original.rationale ?? '')) {
          patch.rationale = o.rationale.length > 0 ? o.rationale : null;
          changed = true;
        }
        return changed ? patch : null;
      })
      .filter(
        (p): p is { id: string; option_text?: string; rationale?: string | null } => p !== null
      );
    if (optionEdits.length > 0) edits.options = optionEdits;
    return Object.keys(edits).length > 0 ? edits : undefined;
  };

  const run = async (which: 'save' | 'approve' | 'reject') => {
    const client = getSupabase();
    if (!client) return;
    setBusy(which);
    setError(null);
    try {
      const decision = which === 'approve' ? 'approve' : which === 'reject' ? 'reject' : undefined;
      await decideReviewQuestion(client, question.id, { decision, edits: buildEdits() });
      if (decision) onDecided(question.id);
    } catch (err) {
      setError((err as { message?: string }).message ?? 'That action failed. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <SectionIcon section="profile" name="shield-checkmark-outline" size={18} />
        <Text style={styles.cardTitle} numberOfLines={1}>
          {question.courses?.title ?? 'Unknown course'}
        </Text>
        <Pill
          label={question.status === 'flagged' ? 'Flagged' : 'Generated'}
          tone={question.status === 'flagged' ? 'warn' : 'neutral'}
        />
      </View>

      <Text style={styles.meta}>
        {QUESTION_TYPE_LABELS[question.question_type]} ·{' '}
        {QUESTION_DIFFICULTY_LABELS[question.difficulty]} ·{' '}
        {COGNITIVE_LEVEL_LABELS[question.cognitive_level]}
      </Text>

      {question.safety_flags.length > 0 ? (
        <Text style={styles.flagged}>Flagged for: {question.safety_flags.join(', ')}</Text>
      ) : null}

      <ErrorBanner message={error} />

      <Field label="Stem" value={stem} onChangeText={setStem} multiline />

      <Text style={styles.label}>Options</Text>
      {options.map((opt, idx) => (
        <View key={opt.id} style={styles.optionRow}>
          <View style={styles.optionHeader}>
            <Text style={styles.optionOrdinal}>{opt.ordinal}.</Text>
            <Pill
              label={opt.is_correct ? 'Correct' : 'Distractor'}
              tone={opt.is_correct ? 'good' : 'neutral'}
            />
          </View>
          <Field
            label={`Option ${opt.ordinal} text`}
            value={opt.option_text}
            onChangeText={(text) =>
              setOptions((prev) =>
                prev.map((o, i) => (i === idx ? { ...o, option_text: text } : o))
              )
            }
          />
          <Field
            label={`Option ${opt.ordinal} rationale (optional)`}
            value={opt.rationale}
            onChangeText={(text) =>
              setOptions((prev) => prev.map((o, i) => (i === idx ? { ...o, rationale: text } : o)))
            }
            multiline
          />
        </View>
      ))}

      <Field label="Question rationale" value={rationale} onChangeText={setRationale} multiline />

      <View style={styles.actions}>
        <SecondaryButton
          label={busy === 'save' ? 'Saving…' : 'Save edits'}
          onPress={() => run('save')}
          disabled={busy !== null}
        />
        <SecondaryButton
          label={busy === 'reject' ? 'Rejecting…' : 'Reject'}
          onPress={() => run('reject')}
          disabled={busy !== null}
          destructive
        />
        <PrimaryButton
          label="Approve"
          onPress={() => run('approve')}
          busy={busy === 'approve'}
          disabled={busy !== null && busy !== 'approve'}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted, fontSize: 15, lineHeight: 22 },
  empty: { gap: spacing(3), marginTop: spacing(4) },
  emptyTitle: { ...type.title, color: colors.text },
  list: { gap: spacing(4), marginTop: spacing(4) },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing(4),
    gap: spacing(2),
    ...shadow.sm,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing(2.5) },
  cardTitle: { ...type.heading, fontSize: 16, color: colors.text, flex: 1, flexShrink: 1 },
  meta: { fontSize: 13, color: colors.textMuted },
  flagged: { fontSize: 13, color: sectionAccents.weaknesses.accent, fontWeight: '600' },
  label: { fontSize: 13, fontWeight: '600', color: colors.text, marginTop: spacing(2) },
  optionRow: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing(3),
    gap: spacing(1),
  },
  optionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing(2) },
  optionOrdinal: { fontSize: 14, fontWeight: '600', color: colors.textMuted },
  actions: { flexDirection: 'row', gap: spacing(2), marginTop: spacing(2), flexWrap: 'wrap' },
});
