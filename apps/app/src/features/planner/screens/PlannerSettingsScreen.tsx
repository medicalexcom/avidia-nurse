import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import {
  AVAILABILITY_PRESETS,
  availabilityFromPreset,
  clampMinutes,
  normalizeWeek,
  type AvailabilityPreset,
} from '@avidia/planner';

import { getSupabase } from '../../../lib/supabase';
import { ErrorBanner, PrimaryButton, Screen } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import { useAuth } from '../../auth/AuthProvider';
import {
  clearScheduledReminders,
  remindersSupported,
  requestReminderPermission,
} from '../notifications';
import {
  defaultPlannerSettings,
  fetchPlannerSettings,
  savePlannerSettings,
  type PlannerSettings,
} from '../plannerApi';

/**
 * Availability + reminder preferences — M13 (spec B/C/AA/AB/AC).
 *
 * Availability is a PREFERENCE, never a judgment (spec C): presets are plain
 * descriptions of time, and custom lets each weekday differ. Reminder toggles
 * all default OFF (spec AB) and permission is requested only here, in direct
 * response to the student turning one on (spec AA).
 */

const PRESET_OPTIONS: { key: AvailabilityPreset; label: string; hint: string }[] = [
  { key: 'light', label: 'Light', hint: `~${AVAILABILITY_PRESETS.light} min/day` },
  { key: 'standard', label: 'Standard', hint: `~${AVAILABILITY_PRESETS.standard} min/day` },
  { key: 'intensive', label: 'Intensive', hint: `~${AVAILABILITY_PRESETS.intensive} min/day` },
  { key: 'custom', label: 'Custom', hint: 'Set each day' },
];

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CUSTOM_STEPS = [0, 20, 45, 90] as const;

export function PlannerSettingsScreen() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<PlannerSettings>(defaultPlannerSettings());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) {
      setLoading(false);
      return;
    }
    try {
      setSettings(await fetchPlannerSettings(client, user.id));
      setError(null);
    } catch {
      setError('We could not load your settings. Please try again.');
    }
    setLoading(false);
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const persist = useCallback(
    async (next: PlannerSettings) => {
      const client = getSupabase();
      if (!client || !user) return;
      setSaving(true);
      try {
        await savePlannerSettings(client, user.id, next);
        setError(null);
        const anyOn =
          next.reminders.studyReminders ||
          next.reminders.reviewReminders ||
          next.reminders.examReminders;
        if (!anyOn) await clearScheduledReminders();
      } catch {
        setError('We could not save your settings. Please try again.');
      }
      setSaving(false);
    },
    [user]
  );

  const setPreset = (preset: AvailabilityPreset) => {
    const next: PlannerSettings = {
      ...settings,
      availability:
        preset === 'custom'
          ? { preset: 'custom', minutesByWeekday: settings.availability.minutesByWeekday }
          : availabilityFromPreset(preset),
    };
    setSettings(next);
    persist(next);
  };

  const cycleWeekday = (weekday: number) => {
    const current = clampMinutes(settings.availability.minutesByWeekday[weekday] ?? 0);
    const index = CUSTOM_STEPS.findIndex((step) => step >= current);
    const nextValue = CUSTOM_STEPS[(index + 1) % CUSTOM_STEPS.length] ?? 0;
    const week = [...settings.availability.minutesByWeekday] as number[];
    week[weekday] = nextValue;
    const next: PlannerSettings = {
      ...settings,
      availability: { preset: 'custom', minutesByWeekday: normalizeWeek(week) },
    };
    setSettings(next);
    persist(next);
  };

  const toggleReminder = async (
    key: 'studyReminders' | 'reviewReminders' | 'examReminders',
    value: boolean
  ) => {
    setNotice(null);
    if (value && !remindersSupported()) {
      // Spec AI: web has no local notifications — the planner still works.
      setNotice('Reminders are available in the mobile app. Your plan works fine without them.');
      return;
    }
    if (value) {
      // Spec AA: contextual permission request, only on explicit opt-in.
      const granted = await requestReminderPermission();
      if (!granted) {
        setNotice('Notifications are not permitted on this device, so reminders stay off.');
        return;
      }
    }
    const next: PlannerSettings = {
      ...settings,
      reminders: { ...settings.reminders, [key]: value },
    };
    setSettings(next);
    await persist(next);
  };

  const setHour = (key: 'reminderHour' | 'quietStartHour' | 'quietEndHour', delta: number) => {
    const next: PlannerSettings = {
      ...settings,
      reminders: {
        ...settings.reminders,
        [key]: (settings.reminders[key] + delta + 24) % 24,
      },
    };
    setSettings(next);
    persist(next);
  };

  if (loading) {
    return (
      <Screen title="Availability & reminders">
        <Text style={styles.muted}>Loading settings…</Text>
      </Screen>
    );
  }

  const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

  const hourStepper = (label: string, key: 'reminderHour' | 'quietStartHour' | 'quietEndHour') => (
    <View style={styles.hourRow}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.hourControls}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Earlier ${label}`}
          onPress={() => setHour(key, -1)}
          style={styles.hourButton}
        >
          <Text style={styles.hourButtonText}>−</Text>
        </Pressable>
        <Text style={styles.hourValue}>{hourLabel(settings.reminders[key])}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Later ${label}`}
          onPress={() => setHour(key, 1)}
          style={styles.hourButton}
        >
          <Text style={styles.hourButtonText}>+</Text>
        </Pressable>
      </View>
    </View>
  );

  return (
    <Screen title="Availability & reminders">
      <ErrorBanner message={error} />
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      <View style={styles.card}>
        <Text style={styles.cardHeading}>How much time do you usually have?</Text>
        <Text style={styles.muted}>
          This is a preference, not a commitment — your plan adapts whenever it changes.
        </Text>
        <View style={styles.presetRow}>
          {PRESET_OPTIONS.map((option) => {
            const selected = settings.availability.preset === option.key;
            return (
              <Pressable
                key={option.key}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`${option.label} availability, ${option.hint}`}
                onPress={() => setPreset(option.key)}
                style={[styles.presetChip, selected && styles.presetChipSelected]}
              >
                <Text style={selected ? styles.presetTextSelected : styles.presetText}>
                  {option.label}
                </Text>
                <Text style={styles.presetHint}>{option.hint}</Text>
              </Pressable>
            );
          })}
        </View>
        {settings.availability.preset === 'custom' ? (
          <View style={styles.weekRow}>
            {WEEKDAY_LABELS.map((label, weekday) => (
              <Pressable
                key={label}
                accessibilityRole="button"
                accessibilityLabel={`${label}: ${settings.availability.minutesByWeekday[weekday] ?? 0} minutes. Tap to change.`}
                onPress={() => cycleWeekday(weekday)}
                style={styles.dayChip}
              >
                <Text style={styles.dayLabel}>{label}</Text>
                <Text style={styles.dayMinutes}>
                  {settings.availability.minutesByWeekday[weekday] ?? 0}m
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardHeading}>Reminders</Text>
        <Text style={styles.muted}>
          All reminders are optional and off by default. They only say a plan or exam is coming up —
          never anything about your performance.
        </Text>
        <View style={styles.toggleRow}>
          <Text style={styles.rowLabel}>Daily study plan reminder</Text>
          <Switch
            accessibilityLabel="Daily study plan reminder"
            value={settings.reminders.studyReminders}
            onValueChange={(value) => toggleReminder('studyReminders', value)}
          />
        </View>
        <View style={styles.toggleRow}>
          <Text style={styles.rowLabel}>Due-review reminder</Text>
          <Switch
            accessibilityLabel="Due review reminder"
            value={settings.reminders.reviewReminders}
            onValueChange={(value) => toggleReminder('reviewReminders', value)}
          />
        </View>
        <View style={styles.toggleRow}>
          <Text style={styles.rowLabel}>Exam countdown reminder</Text>
          <Switch
            accessibilityLabel="Exam countdown reminder"
            value={settings.reminders.examReminders}
            onValueChange={(value) => toggleReminder('examReminders', value)}
          />
        </View>
        {hourStepper('Reminder time', 'reminderHour')}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardHeading}>Quiet hours</Text>
        <Text style={styles.muted}>Reminders inside this window move to when it ends.</Text>
        {hourStepper('Quiet from', 'quietStartHour')}
        {hourStepper('Quiet until', 'quietEndHour')}
      </View>

      <PrimaryButton
        label={saving ? 'Saving…' : 'Done'}
        onPress={() => router.back()}
        busy={saving}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted, marginBottom: spacing(3) },
  notice: { color: colors.text, marginBottom: spacing(3) },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(4),
  },
  cardHeading: { color: colors.text, fontWeight: '600', fontSize: 16, marginBottom: spacing(2) },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2) },
  presetChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: spacing(2),
    paddingHorizontal: spacing(3),
    minHeight: 44,
    justifyContent: 'center',
  },
  presetChipSelected: { borderColor: colors.primary, backgroundColor: colors.badge },
  presetText: { color: colors.textMuted, fontWeight: '600' },
  presetTextSelected: { color: colors.text, fontWeight: '700' },
  presetHint: { color: colors.textMuted, fontSize: 12 },
  weekRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2), marginTop: spacing(3) },
  dayChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: spacing(2),
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayLabel: { color: colors.textMuted, fontSize: 12 },
  dayMinutes: { color: colors.text, fontWeight: '600' },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing(2),
    minHeight: 44,
  },
  rowLabel: { color: colors.text, flexShrink: 1 },
  hourRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing(2),
  },
  hourControls: { flexDirection: 'row', alignItems: 'center', gap: spacing(2) },
  hourButton: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hourButtonText: { color: colors.text, fontSize: 18 },
  hourValue: { color: colors.text, fontWeight: '600', minWidth: 52, textAlign: 'center' },
});
