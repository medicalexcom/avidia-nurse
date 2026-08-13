import { useCallback, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import {
  DOCUMENT_TYPE_LABELS,
  formatBytes,
  formatInZone,
  PROCESSING_STATUS_LABELS,
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
import { fetchOwnCourse, type Course } from '../../courses/coursesApi';
import { enqueueDocument, listDocuments, type DocumentRow } from '../documentsApi';
import { createMaterialSignedUrl } from '../materialStorage';
import { deleteMaterial, uploadMaterial } from '../uploadService';
import { pickMaterialFile } from '../filePicker';

const TWO_COLUMN_MIN_WIDTH = 900;
const LOAD_ERROR = 'We could not load your materials. Please try again.';

/**
 * Materials list for a course (M3 spec H, M4 spec K).
 *
 * Shows metadata + status for every document. Documents now move through the
 * M4 pipeline (Queued → Processing → Ready), and failures are split by kind:
 * a failed *upload* (no stored object) offers "Try again" (re-pick the file),
 * while a failed *processing* run (object safely stored) offers
 * "Try processing again" (re-enqueue — no re-upload needed). Error messages
 * shown here are the student-safe ones the worker writes; internal detail
 * (stack traces, parser errors, paths) never reaches this screen.
 */

/**
 * Failed uploads and failed processing runs read differently to students.
 * For extracted documents the label reflects the M5 indexing lifecycle in
 * honest, student-facing terms — "Ready to study" once retrieval works,
 * "Preparing study tools" while chunks/embeddings are being built (never
 * jargon like "vectorized"). An internal indexing failure is retried by the
 * worker; the document itself remains readable, so it stays "Ready".
 */
function statusLabelFor(doc: DocumentRow): string {
  if (doc.processing_status === 'failed' && doc.storage_key) {
    return 'Processing failed';
  }
  if (doc.processing_status === 'ready') {
    if (doc.index_status === 'indexed') {
      return 'Ready to study';
    }
    if (doc.index_status === 'pending' || doc.index_status === 'indexing') {
      return 'Preparing study tools';
    }
    return PROCESSING_STATUS_LABELS.ready;
  }
  return PROCESSING_STATUS_LABELS[doc.processing_status];
}
export function MaterialsScreen({ courseId }: { courseId: string }) {
  const { user } = useAuth();
  const timezone = useUserTimezone();
  const { width } = useWindowDimensions();
  const wide = width >= TWO_COLUMN_MIN_WIDTH;

  const [course, setCourse] = useState<Course | null>(null);
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) return;
    try {
      const [c, docs] = await Promise.all([
        fetchOwnCourse(client, user.id, courseId),
        listDocuments(client, courseId),
      ]);
      setCourse(c);
      setDocuments(docs);
      setError(c ? null : 'This course could not be found.');
    } catch {
      setError(LOAD_ERROR);
    }
  }, [user, courseId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onOpen = async (doc: DocumentRow) => {
    const client = getSupabase();
    if (!client || !doc.storage_key) return;
    try {
      const url = await createMaterialSignedUrl(client, doc.storage_key);
      await Linking.openURL(url);
    } catch {
      setError('We could not open this material. Please try again.');
    }
  };

  const onDelete = async (doc: DocumentRow) => {
    const client = getSupabase();
    if (!client || busyId) return;
    setBusyId(doc.id);
    try {
      await deleteMaterial(client, doc);
      setConfirmingId(null);
      setExpandedId(null);
      await load();
    } catch {
      // Storage removal is idempotent, so deleting again converges.
      setError('We could not delete this material. Please try again.');
    } finally {
      setBusyId(null);
    }
  };

  /** uploaded -> queued, or failed(processing) -> queued. No re-upload. */
  const onProcess = async (doc: DocumentRow) => {
    const client = getSupabase();
    if (!client || busyId) return;
    setBusyId(doc.id);
    try {
      await enqueueDocument(client, doc.id);
      await load();
    } catch {
      setError('We could not start processing. Please try again.');
    } finally {
      setBusyId(null);
    }
  };

  const onRetry = async (doc: DocumentRow) => {
    const client = getSupabase();
    if (!client || !user || busyId) return;
    try {
      const picked = await pickMaterialFile();
      if (picked.kind === 'cancelled') return;
      setBusyId(doc.id);
      const outcome = await uploadMaterial(client, {
        userId: user.id,
        courseId,
        file: picked.file,
        documentType: doc.document_type,
        allowDuplicate: true,
      });
      if (outcome.kind === 'uploaded') {
        await deleteMaterial(client, doc); // replace the failed entry
        setExpandedId(null);
        await load();
      } else if (outcome.kind === 'invalid') {
        setError(outcome.error);
      } else if (outcome.kind === 'failed') {
        setError(outcome.error);
        await load();
      }
    } catch {
      setError('The upload did not complete. Please check your connection and try again.');
    } finally {
      setBusyId(null);
    }
  };

  const loading = documents === null && !error;

  return (
    <Screen title={course ? `${course.title} — Materials` : 'Materials'}>
      <ErrorBanner message={error} />
      {error ? <SecondaryButton label="Retry" onPress={load} /> : null}

      {loading ? <Text style={styles.muted}>Loading materials…</Text> : null}

      {documents && documents.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No materials yet</Text>
          <Text style={styles.muted}>
            Upload lecture slides, study guides or notes for this course. Everything you upload
            stays private to your account.
          </Text>
          <PrimaryButton
            label="Add your first material"
            onPress={() => router.push(`/course/${courseId}/add-material`)}
          />
        </View>
      ) : null}

      {documents && documents.length > 0 ? (
        <>
          <View style={[styles.list, wide && styles.listWide]}>
            {documents.map((doc) => (
              <View key={doc.id} style={[styles.card, wide && styles.cardWide]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Material ${doc.original_filename}`}
                  onPress={() => setExpandedId(expandedId === doc.id ? null : doc.id)}
                >
                  <Text style={styles.cardTitle}>{doc.original_filename}</Text>
                  <Text style={styles.meta}>
                    {DOCUMENT_TYPE_LABELS[doc.document_type]} · {formatBytes(doc.file_size)} ·{' '}
                    {formatInZone(doc.created_at, timezone)}
                  </Text>
                  <Text
                    style={[styles.status, doc.processing_status === 'failed' && styles.failed]}
                  >
                    {statusLabelFor(doc)}
                  </Text>
                </Pressable>

                {expandedId === doc.id ? (
                  <View style={styles.detail}>
                    <Text style={styles.meta}>File type: {doc.file_extension.toUpperCase()}</Text>
                    <Text style={styles.meta}>Size: {formatBytes(doc.file_size)}</Text>
                    <Text style={styles.meta}>
                      Uploaded: {formatInZone(doc.created_at, timezone)}
                    </Text>
                    <Text style={styles.meta}>Status: {statusLabelFor(doc)}</Text>
                    {doc.error_message ? (
                      <Text style={styles.failed}>{doc.error_message}</Text>
                    ) : null}
                    <View style={styles.detailActions}>
                      {doc.storage_key ? (
                        <SecondaryButton label="Open" onPress={() => onOpen(doc)} />
                      ) : null}
                      {doc.processing_status === 'uploaded' ? (
                        <SecondaryButton
                          label="Process"
                          disabled={busyId !== null}
                          onPress={() => onProcess(doc)}
                        />
                      ) : null}
                      {doc.processing_status === 'failed' && doc.storage_key ? (
                        <SecondaryButton
                          label="Try processing again"
                          disabled={busyId !== null}
                          onPress={() => onProcess(doc)}
                        />
                      ) : null}
                      {doc.processing_status === 'failed' && !doc.storage_key ? (
                        <SecondaryButton
                          label="Try again"
                          disabled={busyId !== null}
                          onPress={() => onRetry(doc)}
                        />
                      ) : null}
                      <SecondaryButton
                        label="Delete"
                        destructive
                        disabled={busyId !== null}
                        onPress={() => setConfirmingId(doc.id)}
                      />
                    </View>
                    {confirmingId === doc.id ? (
                      <ConfirmInline
                        message={`Delete “${doc.original_filename}”? The stored file will be removed permanently. This cannot be undone.`}
                        confirmLabel="Delete material"
                        onConfirm={() => onDelete(doc)}
                        onCancel={() => setConfirmingId(null)}
                      />
                    ) : null}
                  </View>
                ) : null}
              </View>
            ))}
          </View>
          <PrimaryButton
            label="Add material"
            onPress={() => router.push(`/course/${courseId}/add-material`)}
          />
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.textMuted, fontSize: 15, lineHeight: 22 },
  meta: { color: colors.textMuted, fontSize: 14 },
  empty: { alignItems: 'flex-start', gap: spacing(3), paddingVertical: spacing(4) },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  list: { gap: spacing(3), marginBottom: spacing(4) },
  listWide: { flexDirection: 'row', flexWrap: 'wrap' },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(4),
    gap: spacing(1),
  },
  cardWide: { flexBasis: '48%', flexGrow: 1 },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  status: { fontSize: 14, color: colors.primary, fontWeight: '600' },
  failed: { color: colors.danger, fontSize: 14, fontWeight: '600' },
  detail: {
    marginTop: spacing(3),
    paddingTop: spacing(3),
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing(2),
  },
  detailActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2) },
});
