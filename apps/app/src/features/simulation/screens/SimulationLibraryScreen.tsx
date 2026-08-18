import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { useAuth } from '../../auth/AuthProvider';
import { getSupabase } from '../../../lib/supabase';
import { trackEvent } from '../../../lib/analytics';
import { ErrorBanner, PrimaryButton, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import { fetchOwnCourse, type Course } from '../../courses/coursesApi';
import {
  listOwnSimulationSessions,
  listSimulationCases,
  startSimulation,
  type SimulationCaseRow,
  type SimulationSessionRow,
} from '../simulationApi';
import {
  listLearningRequests,
  requestLearningArtifact,
  type LearningRequest,
} from '../../aiLearning/aiLearningApi';

// Generation is asynchronous background work (a background worker validates
// the AI-authored case before it becomes runnable). Poll for completion
// instead of requiring a manual refresh, so "Creating simulation…" resolves
// on its own to either a ready case or a clear failure message. Timeout is kept above the worker's 5-minute cron cadence (.github/workflows/worker.yml) plus generation time.
const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 420000;

/**
 * Simulation case library — M11 (spec AE/AF/X).
 *
 * Lists the small, validated built-in case library with honest metadata
 * (difficulty, scenario type, estimated time). If an ACTIVE session already
 * exists for a case, the button says "Resume" and the server resumes it —
 * starting is idempotent (spec X). Completed runs link to their debrief.
 */
export function SimulationLibraryScreen({ courseId }: { courseId: string }) {
  const { user } = useAuth();
  const [course, setCourse] = useState<Course | null>(null);
  const [cases, setCases] = useState<SimulationCaseRow[] | null>(null);
  const [sessions, setSessions] = useState<SimulationSessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [startingKey, setStartingKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [topic, setTopic] = useState('');
  // Simulation-kind ai_learning_requests still queued or being processed —
  // rendered as "Creating simulation…" cards (spec: the library must
  // surface generation status on a normal refresh, no hidden dev action).
  const [pendingRequests, setPendingRequests] = useState<LearningRequest[]>([]);
  // The most recent failed request, shown until the student dismisses it or
  // starts a new generation — so a stale failure doesn't linger forever,
  // but also isn't silently lost on the next screen focus.
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
      const [c, caseRows, sessionRows, requests] = await Promise.all([
        fetchOwnCourse(client, user.id, courseId),
        listSimulationCases(client, courseId),
        listOwnSimulationSessions(client, courseId),
        listLearningRequests(client, courseId, 'simulation'),
      ]);
      setCourse(c);
      setCases(caseRows);
      setSessions(sessionRows);
      setPendingRequests(
        requests.filter((r) => r.status === 'queued' || r.status === 'processing')
      );
      const latestFailed = requests.find((r) => r.status === 'failed');
      setFailedRequest(latestFailed ?? null);
      setError(c ? null : 'This course could not be found.');
    } catch {
      setError('We could not load the simulation library. Please try again.');
    }
    setLoading(false);
  }, [user, courseId]);

  // While any simulation request is still queued/processing, keep polling
  // and reloading so a case that finishes moves itself from "Creating…" to
  // "Start" without the student having to do anything.
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
    if (pendingRequests.length > 0) pollUntilSettled();
    else stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRequests.length]);

  const generate = useCallback(
    async (mode: string, topic?: string) => {
      const client = getSupabase();
      if (!client || !user) return;
      setGenerating(true);
      setError(null);
      try {
        const request = await requestLearningArtifact(client, user.id, courseId, 'simulation', {
          mode,
          topic,
          difficulty: 'advanced',
          nonce: mode === 'surprise' || mode === 'another' ? new Date().toISOString() : undefined,
        });
        if (request.status === 'queued' || request.status === 'processing') {
          setPendingRequests((prev) => [request, ...prev.filter((r) => r.id !== request.id)]);
        } else {
          await load();
        }
      } catch {
        setError('Avidia could not queue a new simulation. Built-in simulations still work.');
      }
      setGenerating(false);
    },
    [courseId, load, user]
  );

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onStart = useCallback(
    async (caseRow: SimulationCaseRow) => {
      const client = getSupabase();
      if (!client) return;
      setStartingKey(caseRow.case_key);
      setError(null);
      try {
        const result = await startSimulation(client, courseId, caseRow.case_key);
        trackEvent({
          name: 'simulation_started',
          caseKey: caseRow.case_key,
          resumed: result.resumed,
        });
        router.push(`/simulation/${result.session_id}`);
      } catch {
        setError('We could not start this simulation. Please try again.');
      }
      setStartingKey(null);
    },
    [courseId]
  );

  if (loading) {
    return (
      <Screen title="Patient simulations">
        <Text style={styles.muted}>Loading the case library…</Text>
      </Screen>
    );
  }

  if (!course || !cases) {
    return (
      <Screen title="Patient simulations">
        <ErrorBanner message={error} />
        <SecondaryButton label="Retry" onPress={load} />
        <SecondaryButton label="Back to courses" onPress={() => router.replace('/courses')} />
      </Screen>
    );
  }

  return (
    <Screen title={`Patient simulations — ${course.title}`}>
      <ErrorBanner message={error} />
      <Text style={styles.intro}>
        Care for a virtual patient one decision at a time. Every case is fully scripted and
        deterministic — your actions, in your order, decide how it unfolds. Results feed the same
        mastery picture as your practice questions.
      </Text>
      <View style={styles.card}>
        <Text style={styles.title}>Generate a personalized simulation</Text>
        <Text style={styles.tagline}>
          AI authors a validated case once; M11 runs every action and outcome deterministically.
        </Text>
        <TextInput
          accessibilityLabel="Simulation topic"
          placeholder="Optional topic"
          value={topic}
          onChangeText={setTopic}
          style={styles.input}
        />
        {(
          [
            ['recommended', 'Recommended for Me'],
            ['upcoming_exam', 'Upcoming Exam'],
            ['weakest', 'My Weakest Area'],
            ['topic', 'Choose Topic'],
            ['surprise', 'Surprise Me'],
          ] as const
        ).map(([mode, label]) => (
          <SecondaryButton
            key={mode}
            label={label}
            onPress={() => generate(mode, mode === 'topic' ? topic : undefined)}
            disabled={generating}
          />
        ))}
        <PrimaryButton
          label="Generate New Simulation"
          onPress={() => generate('recommended')}
          busy={generating}
        />
      </View>
      {pendingRequests.map((request) => (
        <View key={request.id} style={styles.card}>
          <Text style={styles.title}>Creating simulation…</Text>
          <Text style={styles.tagline}>
            Avidia is authoring and validating this case. It will appear below automatically — no
            need to refresh.
          </Text>
        </View>
      ))}
      {failedRequest && dismissedFailedId !== failedRequest.id ? (
        <View style={styles.card}>
          <Text style={styles.title}>Simulation couldn&apos;t be created</Text>
          <Text style={styles.tagline}>Try again, or choose a different topic.</Text>
          <SecondaryButton label="Dismiss" onPress={() => setDismissedFailedId(failedRequest.id)} />
        </View>
      ) : null}
      {cases.length === 0 && pendingRequests.length === 0 ? (
        <Text style={styles.muted}>
          No simulation cases are available yet. The case library is seeded with the app — check
          back after your next update.
        </Text>
      ) : null}
      {cases.map((caseRow) => {
        const activeSession = sessions.find(
          (s) => s.case_id === caseRow.id && s.status === 'active'
        );
        const completedRuns = sessions.filter(
          (s) => s.case_id === caseRow.id && s.status === 'completed'
        );
        const busy = startingKey === caseRow.case_key;
        return (
          <View key={caseRow.id} style={styles.card}>
            <Text style={styles.title}>{caseRow.title}</Text>
            <Text style={styles.tagline}>{caseRow.description}</Text>
            <Text style={styles.meta}>
              {caseRow.difficulty} · {caseRow.scenario_type.replace(/_/g, ' ')} · about{' '}
              {caseRow.estimated_duration_minutes} min
            </Text>
            {activeSession ? (
              <Text style={styles.resumeNote}>
                You have a session in progress — resuming picks up exactly where you left off.
              </Text>
            ) : null}
            <PrimaryButton
              label={activeSession ? 'Resume simulation' : 'Start simulation'}
              onPress={() => onStart(caseRow)}
              busy={busy}
              disabled={startingKey !== null && !busy}
            />
            {completedRuns[0] ? (
              <SecondaryButton
                label="View last debrief"
                onPress={() => router.push(`/simulation/${completedRuns[0]!.id}/debrief`)}
              />
            ) : null}
            {caseRow.owner_id ? (
              <SecondaryButton
                label="Another Simulation Like This"
                onPress={() => generate('another', caseRow.title)}
                disabled={generating}
              />
            ) : null}
          </View>
        );
      })}
      <SecondaryButton label="Back to course" onPress={() => router.push(`/course/${courseId}`)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted },
  intro: { color: colors.textMuted, marginBottom: spacing(3) },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    gap: spacing(2),
    marginBottom: spacing(3),
    padding: spacing(3),
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '600' },
  tagline: { color: colors.textMuted, fontSize: 14 },
  meta: { color: colors.textMuted, fontSize: 13 },
  resumeNote: { color: colors.primary, fontSize: 13 },
  input: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing(3),
  },
});
