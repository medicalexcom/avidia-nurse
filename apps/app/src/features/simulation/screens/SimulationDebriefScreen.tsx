import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { useAuth } from '../../auth/AuthProvider';
import { getSupabase } from '../../../lib/supabase';
import { ErrorBanner, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import { getSimulationDebrief, type SimulationDebrief } from '../simulationApi';

/**
 * Debrief — M11 (spec AQ/AR/R).
 *
 * The essential post-simulation review: outcome and why, the deterministic
 * score broken down by clinical-judgment dimension, missed critical actions,
 * unsafe actions framed as learning (consequences, not shame — spec R), the
 * key cues that were present whether or not they were found, a step-by-step
 * timeline replay that now reveals what was happening behind the scenes, and
 * how this run fed the same mastery picture as practice questions (spec T/U).
 */

const DIMENSION_LABELS: Record<string, string> = {
  recognize_cues: 'Recognize cues',
  analyze_cues: 'Analyze cues',
  prioritize_hypotheses: 'Prioritize hypotheses',
  generate_solutions: 'Generate solutions',
  take_action: 'Take action',
  evaluate_outcomes: 'Evaluate outcomes',
};

function describeTimelineEvent(event: Record<string, unknown> & { type: string }): string | null {
  switch (event.type) {
    case 'finding_revealed':
      return `Finding revealed: ${String(event.text ?? '')}`;
    case 'no_new_findings':
      return 'No new findings.';
    case 'vitals_observed':
      return 'Vitals snapshot taken.';
    case 'vital_change':
      return `${String(event.vital ?? '')} changed ${String(event.from ?? '')} → ${String(
        event.to ?? ''
      )}`;
    case 'lab_released':
      return `Lab released: ${String(event.name ?? '')}`;
    case 'patient_statement':
      return `Patient: “${String(event.text ?? '')}”`;
    case 'dialogue':
      return `Patient answered: “${String(event.response ?? '')}”`;
    case 'rule_fired':
      return `Behind the scenes: ${String(event.description ?? '')}`;
    case 'action_classified':
      return `This action was ${String(event.classification ?? '')} at that moment.`;
    case 'phase_changed':
      return `The scenario moved into its ${String(event.to ?? '')} phase.`;
    case 'completed':
      return `Scenario ended: ${String(event.label ?? '')}`;
    default:
      return null;
  }
}

export function SimulationDebriefScreen({ sessionId }: { sessionId: string }) {
  const { user } = useAuth();
  const [debrief, setDebrief] = useState<SimulationDebrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) {
      setLoading(false);
      return;
    }
    try {
      setDebrief(await getSimulationDebrief(client, sessionId));
      setError(null);
    } catch {
      setError('The debrief is only available after a simulation is completed.');
    }
    setLoading(false);
  }, [user, sessionId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  if (loading) {
    return (
      <Screen title="Debrief">
        <Text style={styles.muted}>Preparing your debrief…</Text>
      </Screen>
    );
  }

  if (!debrief) {
    return (
      <Screen title="Debrief">
        <ErrorBanner message={error} />
        <SecondaryButton label="Retry" onPress={load} />
        <SecondaryButton label="Back" onPress={() => router.back()} />
      </Screen>
    );
  }

  const missedCues = debrief.keyCues.filter((cue) => !cue.revealed);
  const foundCues = debrief.keyCues.filter((cue) => cue.revealed);

  return (
    <Screen title={`Debrief — ${debrief.case.title}`}>
      <ErrorBanner message={error} />

      <View style={styles.outcomeCard}>
        <Text style={styles.outcomeLabel}>{debrief.outcome.label}</Text>
        <Text style={styles.body}>{debrief.outcome.summary}</Text>
        <Text style={styles.meta}>
          {debrief.durationMinutes} simulated minutes · {debrief.case.difficulty} ·{' '}
          {debrief.case.scenarioType.replace(/_/g, ' ')}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Clinical judgment score</Text>
        <Text style={styles.scoreTotal}>
          {debrief.score.earned} / {debrief.score.possible} points
        </Text>
        {Object.entries(debrief.score.dimensions).map(([dimension, { earned, possible }]) =>
          possible > 0 ? (
            <View key={dimension} style={styles.dimensionRow}>
              <Text style={styles.dimensionLabel}>{DIMENSION_LABELS[dimension] ?? dimension}</Text>
              <Text style={styles.dimensionValue}>
                {earned}/{possible}
              </Text>
            </View>
          ) : null
        )}
        <Text style={styles.meta}>
          Every point maps to a specific, named criterion below — nothing is judged by AI.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>What earned points — and what didn&apos;t</Text>
        {debrief.score.entries.map((entry) => (
          <Text key={entry.id} style={entry.earned ? styles.earned : styles.missed}>
            {entry.earned ? '✓' : '✗'} {entry.label} ({entry.points} pt
            {entry.points === 1 ? '' : 's'})
          </Text>
        ))}
      </View>

      {debrief.missedCriticalActions.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Critical actions to focus on</Text>
          {debrief.missedCriticalActions.map((item) => (
            <Text key={item.criticalId} style={styles.missed}>
              • {item.label}
            </Text>
          ))}
        </View>
      ) : null}

      {debrief.unsafeActionsTaken.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Actions worth rethinking</Text>
          {debrief.unsafeActionsTaken.map((item, index) => {
            const step = debrief.timeline.find((t) => t.actionId === item.actionId);
            return (
              <Text key={`${item.actionId}-${index}`} style={styles.missed}>
                • {step?.label ?? item.actionId} — {item.classification.replace(/_/g, ' ')} in this
                situation. The timeline below shows exactly what it caused.
              </Text>
            );
          })}
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Key cues in this case</Text>
        {foundCues.map((cue) => (
          <Text key={cue.id} style={styles.earned}>
            ✓ {cue.text}
          </Text>
        ))}
        {missedCues.map((cue) => (
          <Text key={cue.id} style={styles.missed}>
            ✗ Not found: {cue.text} ({cue.system.replace(/_/g, ' ')})
          </Text>
        ))}
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Timeline replay</Text>
        <Text style={styles.meta}>
          Your run, step by step — now including what was happening behind the scenes.
        </Text>
        {debrief.timeline.map((step) => (
          <View key={step.seq} style={styles.timelineStep}>
            <Text style={styles.timelineAction}>
              {step.atMinutes} min — {step.label}
              {step.rejected ? ' (not applied)' : ''}
            </Text>
            {step.events.map((event, index) => {
              const text = describeTimelineEvent(event);
              return text !== null ? (
                <Text key={index} style={styles.timelineEvent}>
                  · {text}
                </Text>
              ) : null;
            })}
          </View>
        ))}
      </View>

      {debrief.evidence.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>How this fed your mastery</Text>
          {debrief.evidence.map((item) => (
            <Text key={item.conceptId} style={styles.body}>
              {item.conceptName}: {Math.round(item.masteryBefore * 100)}% →{' '}
              {Math.round(item.masteryAfter * 100)}%
            </Text>
          ))}
          <Text style={styles.meta}>
            Simulations update the same mastery model as your practice questions — one honest
            picture, not a separate score.
          </Text>
        </View>
      ) : null}

      {debrief.recommendations.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Review next</Text>
          {debrief.recommendations.map((topic, index) => (
            <Text key={index} style={styles.body}>
              • {topic}
            </Text>
          ))}
        </View>
      ) : null}

      <SecondaryButton label="Back" onPress={() => router.back()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted },
  meta: { color: colors.textMuted, fontSize: 13 },
  body: { color: colors.text, fontSize: 14 },
  outcomeCard: {
    backgroundColor: colors.surface,
    borderColor: colors.primary,
    borderRadius: 8,
    borderWidth: 2,
    gap: spacing(2),
    marginBottom: spacing(3),
    padding: spacing(3),
  },
  outcomeLabel: { color: colors.text, fontSize: 18, fontWeight: '700' },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    gap: spacing(2),
    marginBottom: spacing(3),
    padding: spacing(3),
  },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  scoreTotal: { color: colors.text, fontSize: 22, fontWeight: '700' },
  dimensionRow: { flexDirection: 'row', justifyContent: 'space-between' },
  dimensionLabel: { color: colors.textMuted, fontSize: 14 },
  dimensionValue: { color: colors.text, fontSize: 14, fontWeight: '600' },
  earned: { color: colors.text, fontSize: 14 },
  missed: { color: colors.danger, fontSize: 14 },
  timelineStep: { gap: spacing(1), marginBottom: spacing(2) },
  timelineAction: { color: colors.text, fontSize: 14, fontWeight: '600' },
  timelineEvent: { color: colors.textMuted, fontSize: 13, marginLeft: spacing(3) },
});
