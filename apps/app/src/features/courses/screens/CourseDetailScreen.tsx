import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import {
  examCountdown,
  formatInZone,
  moveItem,
  resequence,
  validateModuleTitle,
} from '@avidia/domain';

import { useAuth } from '../../auth/AuthProvider';
import { getSupabase } from '../../../lib/supabase';
import { useUserTimezone } from '../../profile/useTimezone';
import {
  ConfirmInline,
  ErrorBanner,
  PrimaryButton,
  Screen,
  SecondaryButton,
} from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import {
  archiveOwnCourse,
  deleteOwnCourse,
  fetchOwnCourse,
  unarchiveOwnCourse,
  type Course,
} from '../coursesApi';
import {
  createModule,
  deleteModule,
  listModules,
  renameModule,
  saveModuleOrder,
  type Module,
} from '../modulesApi';
import { listExams, type ExamWithModules } from '../examsApi';
import { removeCourseMaterialObjects } from '../../materials/uploadService';

const TWO_COLUMN_MIN_WIDTH = 900;

export function CourseDetailScreen({ courseId }: { courseId: string }) {
  const { user } = useAuth();
  const timezone = useUserTimezone();
  const { width } = useWindowDimensions();
  const twoColumn = width >= TWO_COLUMN_MIN_WIDTH;

  const [course, setCourse] = useState<Course | null>(null);
  const [modules, setModules] = useState<Module[]>([]);
  const [exams, setExams] = useState<ExamWithModules[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) {
      setLoading(false);
      return;
    }
    try {
      const [c, m, e] = await Promise.all([
        fetchOwnCourse(client, user.id, courseId),
        listModules(client, courseId),
        listExams(client, courseId),
      ]);
      setCourse(c);
      setModules(m);
      setExams(e);
      setError(c ? null : 'This course could not be found.');
    } catch {
      setError('We could not load this course. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [user, courseId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onToggleArchive = async () => {
    const client = getSupabase();
    if (!client || !user || !course) return;
    try {
      const updated =
        course.status === 'archived'
          ? await unarchiveOwnCourse(client, user.id, course.id)
          : await archiveOwnCourse(client, user.id, course.id);
      setCourse(updated);
    } catch {
      setError('We could not update the course. Please try again.');
    }
  };

  const onDeleteCourse = async () => {
    const client = getSupabase();
    if (!client || !user) return;
    try {
      // Remove stored material objects first: the SQL cascade deletes the
      // document rows, but storage objects are not part of the cascade and
      // must never be orphaned (ADR-0008).
      await removeCourseMaterialObjects(client, courseId);
      await deleteOwnCourse(client, user.id, courseId);
      router.replace('/courses');
    } catch {
      setConfirmingDelete(false);
      setError('We could not delete the course. Please try again.');
    }
  };

  if (loading) {
    return (
      <Screen title="Course">
        <Text style={styles.muted}>Loading course…</Text>
      </Screen>
    );
  }
  if (!course) {
    return (
      <Screen title="Course">
        <ErrorBanner message={error} />
        <SecondaryButton label="Back to courses" onPress={() => router.replace('/courses')} />
      </Screen>
    );
  }

  const modulesSection = (
    <ModulesSection courseId={courseId} modules={modules} onChanged={load} onError={setError} />
  );
  const examsSection = (
    <ExamsSection courseId={courseId} exams={exams} modules={modules} timezone={timezone} />
  );

  return (
    <Screen title={course.title}>
      <ErrorBanner message={error} />
      {error ? <SecondaryButton label="Retry" onPress={load} /> : null}

      <View style={styles.metaCard}>
        {course.term ? <Text style={styles.meta}>Term: {course.term}</Text> : null}
        {course.institution_name ? (
          <Text style={styles.meta}>Institution: {course.institution_name}</Text>
        ) : null}
        {course.status === 'archived' ? (
          <Text style={styles.archivedNote}>This course is archived.</Text>
        ) : null}
        <View style={styles.metaActions}>
          <SecondaryButton
            label="Materials"
            onPress={() => router.push(`/course/${courseId}/materials`)}
          />
          <SecondaryButton
            label="Edit details"
            onPress={() => router.push(`/course/${courseId}/edit`)}
          />
          <SecondaryButton
            label={course.status === 'archived' ? 'Unarchive' : 'Archive'}
            onPress={onToggleArchive}
          />
          <SecondaryButton
            label="Delete course"
            destructive
            onPress={() => setConfirmingDelete(true)}
          />
        </View>
        {confirmingDelete ? (
          <ConfirmInline
            message={`Permanently delete “${course.title}”? This also deletes its ${modules.length} module(s), ${exams.length} exam(s) and any uploaded materials. Your profile and other courses are not affected. If you just want it out of the way, archive it instead. This cannot be undone.`}
            confirmLabel="Delete permanently"
            onConfirm={onDeleteCourse}
            onCancel={() => setConfirmingDelete(false)}
          />
        ) : null}
      </View>

      {twoColumn ? (
        <View style={styles.columns}>
          <View style={styles.column}>{modulesSection}</View>
          <View style={styles.column}>{examsSection}</View>
        </View>
      ) : (
        <>
          {modulesSection}
          {examsSection}
        </>
      )}
    </Screen>
  );
}

function ModulesSection({
  courseId,
  modules,
  onChanged,
  onError,
}: {
  courseId: string;
  modules: Module[];
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [newTitle, setNewTitle] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const onAdd = async () => {
    const client = getSupabase();
    if (!client) return;
    const result = validateModuleTitle(newTitle);
    if (!result.ok) {
      setAddError(result.errors[0] ?? 'Please enter a module title.');
      return;
    }
    setAddError(null);
    try {
      await createModule(client, courseId, result.value, modules.length);
      setNewTitle('');
      onChanged();
    } catch {
      onError('We could not add the module. Please try again.');
    }
  };

  const onRename = async (moduleId: string) => {
    const client = getSupabase();
    if (!client) return;
    const result = validateModuleTitle(editingTitle);
    if (!result.ok) {
      setAddError(result.errors[0] ?? 'Please enter a module title.');
      return;
    }
    setAddError(null);
    try {
      await renameModule(client, moduleId, result.value);
      setEditingId(null);
      onChanged();
    } catch {
      onError('We could not rename the module. Please try again.');
    }
  };

  const onMove = async (from: number, to: number) => {
    const client = getSupabase();
    if (!client || to < 0 || to >= modules.length) return;
    try {
      await saveModuleOrder(client, resequence(moveItem(modules, from, to)));
      onChanged();
    } catch {
      onError('We could not reorder the modules. Please try again.');
    }
  };

  const onDelete = async (moduleId: string) => {
    const client = getSupabase();
    if (!client) return;
    try {
      await deleteModule(client, moduleId);
      setDeletingId(null);
      onChanged();
    } catch {
      onError('We could not delete the module. Please try again.');
    }
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Modules</Text>
      {modules.length === 0 ? (
        <Text style={styles.muted}>
          No modules yet. Add the units or chapters this course covers.
        </Text>
      ) : (
        modules.map((module, index) => (
          <View key={module.id} style={styles.row}>
            {editingId === module.id ? (
              <>
                <TextInput
                  value={editingTitle}
                  onChangeText={setEditingTitle}
                  style={styles.rowInput}
                  accessibilityLabel={`Rename module ${module.title}`}
                />
                <SecondaryButton label="Save" onPress={() => onRename(module.id)} />
                <SecondaryButton label="Cancel" onPress={() => setEditingId(null)} />
              </>
            ) : deletingId === module.id ? (
              <View style={styles.rowConfirm}>
                <ConfirmInline
                  message={`Delete module “${module.title}”? It will also be removed from any exams it is linked to.`}
                  confirmLabel="Delete module"
                  onConfirm={() => onDelete(module.id)}
                  onCancel={() => setDeletingId(null)}
                />
              </View>
            ) : (
              <>
                <Text style={styles.rowTitle}>{module.title}</Text>
                <IconButton
                  label="↑"
                  accessibility={`Move ${module.title} up`}
                  disabled={index === 0}
                  onPress={() => onMove(index, index - 1)}
                />
                <IconButton
                  label="↓"
                  accessibility={`Move ${module.title} down`}
                  disabled={index === modules.length - 1}
                  onPress={() => onMove(index, index + 1)}
                />
                <SecondaryButton
                  label="Rename"
                  onPress={() => {
                    setEditingId(module.id);
                    setEditingTitle(module.title);
                  }}
                />
                <SecondaryButton
                  label="Delete"
                  destructive
                  onPress={() => setDeletingId(module.id)}
                />
              </>
            )}
          </View>
        ))
      )}
      {addError ? <Text style={styles.fieldError}>{addError}</Text> : null}
      <View style={styles.row}>
        <TextInput
          value={newTitle}
          onChangeText={setNewTitle}
          placeholder="New module title"
          placeholderTextColor={colors.textMuted}
          style={styles.rowInput}
          accessibilityLabel="New module title"
        />
        <SecondaryButton label="Add module" onPress={onAdd} />
      </View>
    </View>
  );
}

function ExamsSection({
  courseId,
  exams,
  modules,
  timezone,
}: {
  courseId: string;
  exams: ExamWithModules[];
  modules: Module[];
  timezone: string;
}) {
  const moduleTitle = (id: string) => modules.find((m) => m.id === id)?.title;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Exams</Text>
      {exams.length === 0 ? (
        <Text style={styles.muted}>No exams scheduled yet.</Text>
      ) : (
        exams.map((exam) => {
          const countdown = examCountdown(exam.exam_at, timezone);
          const linked = exam.module_ids.map(moduleTitle).filter(Boolean).join(', ');
          return (
            <Pressable
              key={exam.id}
              accessibilityRole="button"
              accessibilityLabel={`Open exam ${exam.title}`}
              onPress={() => router.push(`/exam/${exam.id}`)}
              style={({ pressed }) => [styles.examCard, pressed && styles.examCardPressed]}
            >
              <Text style={styles.rowTitle}>{exam.title}</Text>
              <Text style={styles.meta}>{formatInZone(exam.exam_at, timezone)}</Text>
              <Text style={styles.countdown}>{countdown.label}</Text>
              {exam.weight != null ? <Text style={styles.meta}>Weight: {exam.weight}%</Text> : null}
              {linked ? <Text style={styles.meta}>Covers: {linked}</Text> : null}
            </Pressable>
          );
        })
      )}
      <PrimaryButton label="Add exam" onPress={() => router.push(`/course/${courseId}/new-exam`)} />
    </View>
  );
}

function IconButton({
  label,
  accessibility,
  onPress,
  disabled,
}: {
  label: string;
  accessibility: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibility}
      onPress={onPress}
      disabled={disabled}
      style={[styles.iconButton, disabled && styles.iconButtonDisabled]}
    >
      <Text style={styles.iconButtonLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted, fontSize: 15, lineHeight: 22 },
  meta: { color: colors.textMuted, fontSize: 14 },
  archivedNote: { color: colors.badgeText, fontSize: 14, fontWeight: '600' },
  metaCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(4),
    gap: spacing(2),
    marginBottom: spacing(5),
  },
  metaActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2) },
  columns: { flexDirection: 'row', gap: spacing(6) },
  column: { flex: 1 },
  section: { marginBottom: spacing(6), gap: spacing(3) },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing(2), flexWrap: 'wrap' },
  rowConfirm: { flex: 1 },
  rowTitle: { flex: 1, fontSize: 15, color: colors.text, minWidth: 120 },
  rowInput: {
    flex: 1,
    minWidth: 140,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2),
    fontSize: 15,
    color: colors.text,
  },
  fieldError: { color: colors.danger, fontSize: 14 },
  examCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(4),
    gap: spacing(1),
  },
  examCardPressed: { backgroundColor: colors.background },
  countdown: { fontSize: 14, color: colors.primary, fontWeight: '600' },
  iconButton: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2),
  },
  iconButtonDisabled: { opacity: 0.4 },
  iconButtonLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
});
