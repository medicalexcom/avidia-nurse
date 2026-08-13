import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';

import { validateCourse } from '@avidia/domain';

import { useAuth } from '../../auth/AuthProvider';
import { getSupabase } from '../../../lib/supabase';
import { ErrorBanner, Field, PrimaryButton, Screen, SecondaryButton } from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import { createCourse, fetchOwnCourse, updateOwnCourse } from '../coursesApi';

/**
 * Create a new course (no courseId) or edit an existing one's metadata.
 * All validation lives in @avidia/domain (validateCourse), not here.
 */
export function CourseFormScreen({ courseId }: { courseId?: string }) {
  const { user } = useAuth();
  const editing = Boolean(courseId);
  const [title, setTitle] = useState('');
  const [term, setTerm] = useState('');
  const [institution, setInstitution] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user || !courseId) {
      setLoading(false);
      return;
    }
    try {
      const course = await fetchOwnCourse(client, user.id, courseId);
      if (course) {
        setTitle(course.title);
        setTerm(course.term ?? '');
        setInstitution(course.institution_name ?? '');
        setBanner(null);
      } else {
        setBanner('This course could not be found.');
      }
    } catch {
      setBanner('We could not load this course. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [user, courseId]);

  useEffect(() => {
    load();
  }, [load]);

  const onSave = async () => {
    const client = getSupabase();
    if (!client || !user) {
      setBanner('You need to be signed in to save a course.');
      return;
    }
    const result = validateCourse({ title, term, institutionName: institution });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      if (courseId) {
        await updateOwnCourse(client, user.id, courseId, result.value);
        router.back();
      } else {
        const course = await createCourse(client, user.id, result.value);
        router.replace(`/course/${course.id}`);
      }
    } catch {
      setBanner('We could not save the course. Please try again.');
      setSaving(false);
    }
  };

  return (
    <Screen title={editing ? 'Edit course' : 'New course'}>
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
            label="Course title"
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Pharmacology"
          />
          <Field
            label="Term (optional)"
            value={term}
            onChangeText={setTerm}
            placeholder="e.g. Fall 2026"
          />
          <Field
            label="Institution (optional)"
            value={institution}
            onChangeText={setInstitution}
            placeholder="e.g. State University"
          />
          <PrimaryButton
            label={editing ? 'Save changes' : 'Create course'}
            onPress={onSave}
            busy={saving}
          />
          <SecondaryButton label="Cancel" onPress={() => router.back()} />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted, fontSize: 15 },
  fieldError: { color: colors.danger, fontSize: 14, marginBottom: spacing(2) },
});
