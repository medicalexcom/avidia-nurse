import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import type { ClientView } from '@avidia/simulation/src/redact';
import type { VitalKey } from '@avidia/simulation/src/types';

import { useAuth } from '../../auth/AuthProvider';
import { getSupabase } from '../../../lib/supabase';
import { trackEvent } from '../../../lib/analytics';
import { ErrorBanner, PrimaryButton, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import {
  abandonSimulation,
  getSimulationView,
  newIdempotencyKey,
  submitSimulationAction,
  type SimulationActionResult,
} from '../simulationApi';

/**
 * The patient chart — M11 (spec AJ/AK/AL/AM/AN/AO).
 *
 * Everything on this screen is the server's redacted ClientView (spec N):
 * the device never sees hidden findings, true current vitals, or rule state.
 * Vitals show WHEN they were taken — an old set does not silently update
 * (spec M). Every tap is one submitted action with a fresh idempotency key,
 * so retries can never double-administer (spec Y). Desktop gets a
 * three-column chart; phones get the same sections stacked (spec AO).
 */

const DESKTOP_MIN_WIDTH = 900;

const VITAL_LABELS: Array<{ key: VitalKey; label: string; unit: string }> = [
  { key: 'hr', label: 'HR', unit: 'bpm' },
  { key: 'sbp', label: 'BP (sys)', unit: 'mmHg' },
  { key: 'dbp', label: 'BP (dia)', unit: 'mmHg' },
  { key: 'rr', label: 'RR', unit: '/min' },
  { key: 'spo2', label: 'SpO2', unit: '%' },
  { key: 'temp_c', label: 'Temp', unit: '°C' },
  { key: 'pain', label: 'Pain', unit: '/10' },
  { key: 'glucose', label: 'Glucose', unit: 'mg/dL' },
];

interface FeedEntry {
  id: string;
  text: string;
  atMinutes: number;
}

function describeEvent(event: Record<string, unknown> & { type: string }): string | null {
  switch (event.type) {
    case 'action_accepted':
      return `You: ${String(event.label ?? event.actionId ?? 'action')}`;
    case 'finding_revealed':
      return `Assessment finding: ${String(event.text ?? '')}`;
    case 'no_new_findings':
      return 'No new findings on this assessment.';
    case 'vitals_observed':
      return 'Vital signs recorded on the chart.';
    case 'lab_released':
      return `Lab result back: ${String(event.name ?? '')}`;
    case 'patient_statement':
      return `Patient: “${String(event.text ?? '')}”`;
    case 'dialogue':
      return `Patient: “${String(event.response ?? '')}”`;
    case 'completed':
      return `Scenario ended: ${String(event.label ?? '')}`;
    default:
      return null;
  }
}

export function SimulationSessionScreen({ sessionId }: { sessionId: string }) {
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const desktop = width >= DESKTOP_MIN_WIDTH;
  const [view, setView] = useState<ClientView | null>(null);
  const [status, setStatus] = useState<'active' | 'completed' | 'abandoned' | null>(null);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [promptPickerFor, setPromptPickerFor] = useState<string | null>(null);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [hintShown, setHintShown] = useState(false);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) {
      setLoading(false);
      return;
    }
    try {
      // Server-side resume (spec X): the authoritative state rebuilds the
      // view; nothing about the session is trusted from this device.
      const result = await getSimulationView(client, sessionId);
      setView(result.view);
      setStatus(result.status);
      setError(null);
    } catch {
      setError('We could not load this simulation session.');
    }
    setLoading(false);
  }, [user, sessionId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const applyResult = useCallback((result: SimulationActionResult) => {
    setView(result.view);
    if (result.rejected === 'simulation_completed') {
      setStatus('completed');
      return;
    }
    if (result.rejected !== null) {
      setError('That action could not be applied. Please pick another.');
      return;
    }
    setError(null);
    const entries: FeedEntry[] = [];
    for (const [index, event] of result.events.entries()) {
      const text = describeEvent(event);
      if (text !== null) {
        entries.push({
          id: `${Date.now()}-${index}`,
          text,
          atMinutes: typeof event.atMinutes === 'number' ? event.atMinutes : 0,
        });
      }
    }
    setFeed((previous) => [...entries.reverse(), ...previous].slice(0, 50));
    if (result.view.completed !== null) {
      setStatus('completed');
      trackEvent({
        name: 'simulation_completed',
        caseKey: result.view.caseId,
        outcomeKind: result.view.completed.kind,
        durationMinutes: result.view.completed.atMinutes,
      });
    }
  }, []);

  const submit = useCallback(
    async (actionId: string, params: Record<string, unknown>) => {
      const client = getSupabase();
      if (!client || submittingId !== null) return;
      setSubmittingId(actionId);
      setPromptPickerFor(null);
      try {
        // A fresh key per tap (spec Y): a network retry of THIS submission
        // returns the stored result instead of re-running the action.
        const result = await submitSimulationAction(
          client,
          sessionId,
          actionId,
          params,
          newIdempotencyKey()
        );
        applyResult(result);
      } catch {
        setError('Your action did not go through. Please try again.');
      }
      setSubmittingId(null);
    },
    [sessionId, submittingId, applyResult]
  );

  const onAction = useCallback(
    (actionId: string, promptRequired: boolean) => {
      if (promptRequired) {
        setPromptPickerFor((current) => (current === actionId ? null : actionId));
        return;
      }
      submit(actionId, {});
    },
    [submit]
  );

  const onAbandon = useCallback(async () => {
    if (!confirmAbandon) {
      setConfirmAbandon(true);
      return;
    }
    const client = getSupabase();
    if (!client || !view) return;
    try {
      await abandonSimulation(client, sessionId);
      trackEvent({ name: 'simulation_abandoned', caseKey: view.caseId });
      router.back();
    } catch {
      setError('We could not close this session. Please try again.');
      setConfirmAbandon(false);
    }
  }, [confirmAbandon, sessionId, view]);

  const onHint = useCallback(() => {
    setHintShown((shown) => !shown);
    if (!hintShown && view) {
      trackEvent({ name: 'hint_used', caseKey: view.caseId });
    }
  }, [hintShown, view]);

  const vitalsRows = useMemo(() => {
    if (!view?.observedVitals) return [];
    return VITAL_LABELS.filter(({ key }) => view.observedVitals!.vitals[key] !== undefined).map(
      ({ key, label, unit }) => ({
        key,
        label,
        unit,
        value: view.observedVitals!.vitals[key]!,
      })
    );
  }, [view]);

  if (loading) {
    return (
      <Screen title="Simulation">
        <Text style={styles.muted}>Opening the patient chart…</Text>
      </Screen>
    );
  }

  if (!view) {
    return (
      <Screen title="Simulation">
        <ErrorBanner message={error} />
        <SecondaryButton label="Retry" onPress={load} />
        <SecondaryButton label="Back" onPress={() => router.back()} />
      </Screen>
    );
  }

  const completed = view.completed;
  const active = status === 'active' && completed === null;
  const vitalsStale =
    view.observedVitals !== null && view.observedVitals.atMinutes < view.timeMinutes;

  const chartColumn = (
    <View style={desktop ? styles.column : undefined}>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Patient</Text>
        <Text style={styles.patientName}>
          {view.patient.name}, {view.patient.age} ({view.patient.sex})
        </Text>
        <Text style={styles.meta}>{view.patient.admittingDiagnosis}</Text>
        <Text style={styles.meta}>Chief complaint: {view.patient.chiefComplaint}</Text>
        <Text style={styles.meta}>Allergies: {view.patient.allergies.join(', ')}</Text>
        <Text style={styles.meta}>Code status: {view.patient.codeStatus}</Text>
        <Text style={styles.meta}>History: {view.patient.history.join('; ')}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Vital signs</Text>
        {view.observedVitals === null ? (
          <Text style={styles.muted}>
            No vitals on the chart yet — obtain a set to see where the patient stands.
          </Text>
        ) : (
          <>
            <Text style={vitalsStale ? styles.staleNote : styles.meta}>
              Taken at {view.observedVitals.atMinutes} min
              {vitalsStale ? ' — this set is not current. Reassess to update it.' : ' (current)'}
            </Text>
            {vitalsRows.map((row) => (
              <View key={row.key} style={styles.vitalRow}>
                <Text style={styles.vitalLabel}>{row.label}</Text>
                <Text style={styles.vitalValue}>
                  {row.value} {row.unit}
                </Text>
              </View>
            ))}
          </>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Assessment findings</Text>
        {view.revealedFindings.length === 0 ? (
          <Text style={styles.muted}>Nothing documented yet — assess the patient.</Text>
        ) : (
          view.revealedFindings.map((finding) => (
            <Text key={finding.id} style={styles.finding}>
              [{finding.system.replace(/_/g, ' ')}] {finding.text}
            </Text>
          ))
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Lab results</Text>
        {view.releasedLabs.length === 0 ? (
          <Text style={styles.muted}>No results have come back yet.</Text>
        ) : (
          view.releasedLabs.map((lab) => (
            <Text key={lab.id} style={styles.finding}>
              {lab.name}: {lab.value} {lab.unit}
              {lab.flag !== 'normal' ? ` (${lab.flag.toUpperCase()})` : ''}
            </Text>
          ))
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Medication orders</Text>
        {view.medicationOrders.map((order) => (
          <Text key={order.id} style={styles.finding}>
            {order.medication} {order.dose} — {order.route}, {order.frequency} ({order.status})
            {order.note ? ` · ${order.note}` : ''}
          </Text>
        ))}
      </View>
    </View>
  );

  const actionsColumn = (
    <View style={desktop ? styles.column : undefined}>
      {completed !== null ? (
        <View style={styles.completedCard}>
          <Text style={styles.completedTitle}>{completed.label}</Text>
          <Text style={styles.meta}>
            The scenario ended at {completed.atMinutes} simulated minutes.
          </Text>
          <PrimaryButton
            label="View your debrief"
            onPress={() => router.push(`/simulation/${sessionId}/debrief`)}
          />
        </View>
      ) : null}
      {status === 'abandoned' ? (
        <View style={styles.card}>
          <Text style={styles.muted}>
            This session was closed without finishing. Start the case again from the library
            whenever you are ready.
          </Text>
        </View>
      ) : null}
      {active ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>What do you do?</Text>
          <Text style={styles.meta}>Simulated time: {view.timeMinutes} min</Text>
          {view.availableActions.map((action) => (
            <View key={action.id}>
              <SecondaryButton
                label={`${action.label}${
                  action.timeCostMinutes > 0 ? ` (${action.timeCostMinutes} min)` : ''
                }`}
                onPress={() => onAction(action.id, action.promptRequired)}
                disabled={submittingId !== null}
              />
              {promptPickerFor === action.id ? (
                <View style={styles.promptPicker}>
                  {view.dialoguePrompts.map((prompt) => (
                    <SecondaryButton
                      key={prompt.id}
                      label={`“${prompt.question}”`}
                      onPress={() => submit(action.id, { promptId: prompt.id })}
                      disabled={submittingId !== null}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          ))}
          <SecondaryButton label={hintShown ? 'Hide hint' : 'Need a hint?'} onPress={onHint} />
          {hintShown ? (
            <Text style={styles.hint}>
              Work the nursing process: assess first (look, listen, measure), recognize what the
              cues mean, act on the priority problem, then reassess to see whether it worked.
            </Text>
          ) : null}
          <SecondaryButton
            label={confirmAbandon ? 'Tap again to leave without finishing' : 'Leave simulation'}
            onPress={onAbandon}
            destructive
          />
        </View>
      ) : null}
    </View>
  );

  const feedColumn = (
    <View style={desktop ? styles.column : undefined}>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>What just happened</Text>
        {view.statements.length > 0 && feed.length === 0
          ? view.statements
              .slice()
              .reverse()
              .map((statement, index) => (
                <Text key={`st-${index}`} style={styles.feedEntry}>
                  [{statement.atMinutes} min] Patient: “{statement.text}”
                </Text>
              ))
          : null}
        {feed.length === 0 && view.statements.length === 0 ? (
          <Text style={styles.muted}>
            Your actions and the patient&apos;s responses appear here.
          </Text>
        ) : (
          feed.map((entry) => (
            <Text key={entry.id} style={styles.feedEntry}>
              [{entry.atMinutes} min] {entry.text}
            </Text>
          ))
        )}
      </View>
    </View>
  );

  return (
    <Screen title={view.title}>
      <ErrorBanner message={error} />
      {desktop ? (
        <View style={styles.columns}>
          {chartColumn}
          {actionsColumn}
          {feedColumn}
        </View>
      ) : (
        <>
          {actionsColumn}
          {chartColumn}
          {feedColumn}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted },
  meta: { color: colors.textMuted, fontSize: 13 },
  columns: { flexDirection: 'row', gap: spacing(3) },
  column: { flex: 1 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    gap: spacing(2),
    marginBottom: spacing(3),
    padding: spacing(3),
  },
  completedCard: {
    backgroundColor: colors.surface,
    borderColor: colors.primary,
    borderRadius: 8,
    borderWidth: 2,
    gap: spacing(2),
    marginBottom: spacing(3),
    padding: spacing(3),
  },
  completedTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  patientName: { color: colors.text, fontSize: 16, fontWeight: '600' },
  vitalRow: { flexDirection: 'row', justifyContent: 'space-between' },
  vitalLabel: { color: colors.textMuted, fontSize: 14 },
  vitalValue: { color: colors.text, fontSize: 14, fontWeight: '600' },
  staleNote: { color: colors.danger, fontSize: 13 },
  finding: { color: colors.text, fontSize: 14 },
  feedEntry: { color: colors.text, fontSize: 13 },
  promptPicker: {
    borderLeftColor: colors.border,
    borderLeftWidth: 2,
    gap: spacing(1),
    marginLeft: spacing(3),
    paddingLeft: spacing(2),
  },
  hint: { color: colors.textMuted, fontSize: 13, fontStyle: 'italic' },
});
