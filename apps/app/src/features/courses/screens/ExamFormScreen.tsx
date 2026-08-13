import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import {
  isoToZonedFields,
  parseDateAndTime,
  validateExam,
  zonedDateTimeToUtc,
} from '@avidia/domain';

import { getSupabase } from '../../../lib/supabase';
import { useUserTimezone } from '../../profile/useTimezone';
import {
  ConfirmInline,
  ErrorBanner,
  Field,
  PrimaryButton,
  Screen,
  SecondaryButton,
} from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import { listModules, type Module } from '../modulesApi';
import { createExam, deleteExam, fetchExam, updateExam } from '../examsApi';

/**
 * Create an exam under a course (courseId given) or edit an existing one
 * (examId given). Date and time are entered in the student's own timezone
 * and converted to a UTC instant by @avidia/domain — no hard-coded timezone
 * anywhere (ADR-0007).
 */
export function ExamFormScreen(props: { courseId: string } | { examId: string }) {
  const examId = 'examId' in props ? props.examId : undefined;
  const timezone = useUserTimezone();
  const editing = Boolean(examId);

  const [courseId, setCourseId] = useState('courseId' in props ? props.courseId : '');
  const [title, setTitle] = useState('');
  const [dateText, setDateText] = useState('');
  const [timeText, setTimeText] = useState('');
  const [weightText, setWeightText] = useState('');
  const [selectedModules, setSelectedModules] = useState<string[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client) {
      setLoading(false);
      return;
    }
    try {
      let cid = 'courseId' in props ? props.courseId : '';
      if (examId) {
        const exam = await fetchExam(client, examId);
        if (!exam) {
          setBanner('This exam could not be found.');
          setLoading(false);
          return;
        }
        cid = exam.course_id;
        setCourseId(cid);
        setTitle(exam.title);
        setWeightText(exam.weight == null ? '' : String(exam.weight));
        setSelectedModules(exam.module_ids);
        const fields = isoToZonedFields(exam.exam_at, timezone);
        if (fields) {
          setDateText(fields.dateText);
          setTimeText(fields.timeText);
        }
      }
      setModules(await listModules(client, cid));
      setBanner(null);
    } catch {
      setBanner('We could not load the exam form. Please try again.');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId, timezone]);

  useEffect(() => {
    load();
  }, [load]);

  // Non-blocking heads-up when the entered date is in the past (allowed —
  // students record historical exams intentionally; it shows as completed).
  const pastNotice = useMemo(() => {
    const parsed = parseDateAndTime(dateText.trim(), timeText.trim());
    if (!parsed) return null;
    const instant = zonedDateTimeToUtc(parsed, timezone);
    if (instant && instant.getTime() < Date.now()) {
      return 'This date is in the past — the exam will be shown as completed.';
    }
    return null;
  }, [dateText, timeText, timezone]);

  const toggleModule = (id: string) => {
    setSelectedModules((current) =>
      current.includes(id) ? current.filter((m) => m !== id) : [...current, id]
    );
  };

  const onSave = async () => {
    const client = getSupabase();
    if (!client) {
      setBanner('You need to be signed in to save an exam.');
      return;
    }
    const parsed = parseDateAndTime(dateText.trim(), timeText.trim());
    const examAt = parsed ? zonedDateTimeToUtc(parsed, timezone) : null;
    const result = validateExam({ title, examAt, weightText });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      if (examId) {
        await updateExam(client, examId, result.value, selectedModules);
        router.back();
      } else {
        await createExam(client, courseId, result.value, selectedModules);
        router.back();
      }
    } catch {
      setBanner('We could not save the exam. Please try again.');
      setSaving(false);
    }
  };

  const onDelete = async () => {
    const client = getSupabase();
    if (!client || !examId) return;
    try {
      await deleteExam(client, examId);
      router.back();
    } catch {
      setConfirmingDelete(false);
      setBanner('We could not delete the exam. Please try again.');
    }
  };

  return (
    <Screen title={editing ? 'Edit exam' : 'New exam'}>
      <ErrorBanner message={banner} />
      {loading ? (
        <Text style={styles.muted}>Loading…</Text>
      ) : (
        <>
          {errors.map((message) => (
            <Text key={message} style={styles.fieldError}>
              {message}
            </Text>
          ))}
          <Field
            label="Exam title"
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Exam 1"
          />
          <Field
            label="Date (YYYY-MM-DD)"
            value={dateText}
            onChangeText={setDateText}
            placeholder="2026-09-04"
            autoCapitalize="none"
          />
          <Field
            label="Time (HH:MM, 24-hour)"
            value={timeText}
            onChangeText={setTimeText}
            placeholder="09:00"
            autoCapitalize="none"
          />
          <Text style={styles.hint}>Times are in your timezone: {timezone}</Text>
          {pastNotice ? <Text style={styles.hint}>{pastNotice}</Text> : null}
          <Field
            label="Weight % (optional, 0–100)"
            value={weightText}
            onChangeText={setWeightText}
            placeholder="e.g. 25"
            keyboardType="numeric"
          />

          <Text style={styles.sectionTitle}>Modules covered</Text>
          {modules.length === 0 ? (
            <Text style={styles.muted}>
              This course has no modules yet. You can add modules on the course page and link them
              to this exam later.
            </Text>
          ) : (
            <View style={styles.moduleList}>
              {modules.map((module) => {
                const selected = selectedModules.includes(module.id);
                return (
                  <Pressable
                    key={module.id}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected }}
                    accessibilityLabel={`Module ${module.title}`}
                    onPress={() => toggleModule(module.id)}
                    style={[styles.moduleChip, selected && styles.moduleChipSelected]}
                  >
                    <Text
                      style={[styles.moduleChipLabel, selected && styles.moduleChipSelectedLabel]}
                    >
                      {selected ? '☑ ' : '☐ '}
                      {module.title}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          <PrimaryButton
            label={editing ? 'Save changes' : 'Create exam'}
            onPress={onSave}
            busy={saving}
          />
          <View style={styles.footerActions}>
            <SecondaryButton label="Cancel" onPress={() => router.back()} />
            {editing ? (
              <SecondaryButton
                label="Delete exam"
                destructive
                onPress={() => setConfirmingDelete(true)}
              />
            ) : null}
          </View>
          {confirmingDelete ? (
            <ConfirmInline
              message="Delete this exam? Its module links are removed too. The modules themselves are kept. This cannot be undone."
              confirmLabel="Delete exam"
              onConfirm={onDelete}
              onCancel={() => setConfirmingDelete(false)}
            />
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted, fontSize: 15, lineHeight: 22 },
  hint: { color: colors.textMuted, fontSize: 13, marginBottom: spacing(3) },
  fieldError: { color: colors.danger, fontSize: 14, marginBottom: spacing(2) },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    marginTop: spacing(2),
    marginBottom: spacing(2),
  },
  moduleList: { gap: spacing(2), marginBottom: spacing(4) },
  moduleChip: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: 8,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2.5),
  },
  moduleChipSelected: { borderColor: colors.primary, backgroundColor: colors.badge },
  moduleChipLabel: { color: colors.text, fontSize: 14 },
  moduleChipSelectedLabel: { color: colors.primary, fontWeight: '600' },
  footerActions: { flexDirection: 'row', gap: spacing(2), marginTop: spacing(2) },
});
