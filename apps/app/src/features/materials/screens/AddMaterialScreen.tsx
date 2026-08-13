import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';

import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  formatBytes,
  type DocumentType,
} from '@avidia/domain';

import { useAuth } from '../../auth/AuthProvider';
import { getSupabase } from '../../../lib/supabase';
import {
  ConfirmInline,
  ErrorBanner,
  PrimaryButton,
  Screen,
  SecondaryButton,
} from '../../../ui/components';
import { colors, spacing } from '../../../ui/theme';
import { pickMaterialFile, type PickedMaterialFile } from '../filePicker';
import { notesToFile, uploadMaterial } from '../uploadService';

const PHI_WARNING =
  'Do not upload patient-identifying information or protected health information (PHI). ' +
  'Lecture slides, study guides, notes and educational cases are perfect here — real patient ' +
  'records are not.';

const GENERIC_UPLOAD_ERROR =
  'The upload did not complete. Please check your connection and try again.';

/**
 * Add Material flow (M3, spec F/G/M).
 *
 * Two paths, both private to the student's course: pick a PDF/PPTX/DOCX/TXT
 * file, or paste notes (stored as a .txt material — no processing happens).
 * The upload button is disabled while an upload is in flight, so repeated
 * taps cannot create duplicates.
 */
export function AddMaterialScreen({ courseId }: { courseId: string }) {
  const { user } = useAuth();

  const [mode, setMode] = useState<'file' | 'notes'>('file');
  const [picked, setPicked] = useState<PickedMaterialFile | null>(null);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteText, setNoteText] = useState('');
  const [documentType, setDocumentType] = useState<DocumentType>('other');
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null);

  const onChooseFile = async () => {
    setError(null);
    try {
      const result = await pickMaterialFile();
      if (result.kind === 'cancelled') return; // keep current state untouched
      setPicked(result.file);
      setDuplicateOf(null);
    } catch {
      setError('We could not read that file. Please try again.');
    }
  };

  const fileToUpload = () => {
    if (mode === 'notes') {
      if (noteText.trim().length === 0) {
        setError('Please paste or type some notes first.');
        return null;
      }
      return notesToFile(noteTitle, noteText);
    }
    if (!picked) {
      setError('Please choose a file first.');
      return null;
    }
    return picked;
  };

  const onUpload = async (allowDuplicate: boolean) => {
    const client = getSupabase();
    if (!client || !user || uploading) return;
    const file = fileToUpload();
    if (!file) return;

    setError(null);
    setDuplicateOf(null);
    setUploading(true);
    try {
      const outcome = await uploadMaterial(client, {
        userId: user.id,
        courseId,
        file,
        documentType: mode === 'notes' ? 'notes' : documentType,
        allowDuplicate,
      });
      if (outcome.kind === 'uploaded') {
        router.back();
        return;
      }
      if (outcome.kind === 'duplicate') {
        setDuplicateOf(outcome.existing.original_filename);
        return;
      }
      setError(outcome.kind === 'invalid' ? outcome.error : outcome.error);
    } catch {
      setError(GENERIC_UPLOAD_ERROR);
    } finally {
      setUploading(false);
    }
  };

  return (
    <Screen title="Add material">
      <View style={styles.phiCard}>
        <Text style={styles.phiText}>{PHI_WARNING}</Text>
      </View>

      <View style={styles.modeRow}>
        <SecondaryButton
          label={mode === 'file' ? '• Upload a file' : 'Upload a file'}
          onPress={() => setMode('file')}
        />
        <SecondaryButton
          label={mode === 'notes' ? '• Paste notes' : 'Paste notes'}
          onPress={() => setMode('notes')}
        />
      </View>

      <ErrorBanner message={error} />

      {mode === 'file' ? (
        <View style={styles.section}>
          <Text style={styles.hint}>Supported: PDF, PPTX, DOCX, TXT — up to 50 MB.</Text>
          <SecondaryButton
            label={picked ? 'Choose a different file' : 'Choose file'}
            onPress={onChooseFile}
          />
          {picked ? (
            <Text style={styles.fileName}>
              {picked.name}
              {picked.size != null ? ` (${formatBytes(picked.size)})` : ''}
            </Text>
          ) : null}

          <Text style={styles.label}>Material type</Text>
          <View style={styles.chips}>
            {DOCUMENT_TYPES.map((type) => (
              <Pressable
                key={type}
                accessibilityRole="radio"
                accessibilityState={{ selected: documentType === type }}
                accessibilityLabel={`Type ${DOCUMENT_TYPE_LABELS[type]}`}
                onPress={() => setDocumentType(type)}
                style={[styles.chip, documentType === type && styles.chipSelected]}
              >
                <Text style={[styles.chipLabel, documentType === type && styles.chipLabelSelected]}>
                  {DOCUMENT_TYPE_LABELS[type]}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : (
        <View style={styles.section}>
          <Text style={styles.label}>Title</Text>
          <TextInput
            value={noteTitle}
            onChangeText={setNoteTitle}
            placeholder="e.g. Renal lecture takeaways"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            accessibilityLabel="Notes title"
          />
          <Text style={styles.label}>Notes</Text>
          <TextInput
            value={noteText}
            onChangeText={setNoteText}
            placeholder="Paste or type your notes here"
            placeholderTextColor={colors.textMuted}
            style={[styles.input, styles.notesInput]}
            multiline
            accessibilityLabel="Notes text"
          />
          <Text style={styles.hint}>Saved as a private text file in this course.</Text>
        </View>
      )}

      {duplicateOf ? (
        <ConfirmInline
          message={`This file appears to have already been uploaded to this course as “${duplicateOf}”. Upload it again anyway?`}
          confirmLabel="Upload anyway"
          onConfirm={() => onUpload(true)}
          onCancel={() => setDuplicateOf(null)}
        />
      ) : null}

      <PrimaryButton
        label={uploading ? 'Uploading…' : 'Upload'}
        disabled={uploading}
        // Fire-and-forget: onUpload guards against re-entry itself, and the
        // button is disabled for the whole flight.
        onPress={() => {
          void onUpload(false);
        }}
      />
      <SecondaryButton label="Cancel" onPress={() => router.back()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  phiCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
    borderRadius: 8,
    padding: spacing(3),
    marginBottom: spacing(4),
  },
  phiText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  modeRow: { flexDirection: 'row', gap: spacing(2), marginBottom: spacing(4) },
  section: { gap: spacing(3), marginBottom: spacing(4) },
  hint: { color: colors.textMuted, fontSize: 14 },
  fileName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  label: { color: colors.text, fontSize: 15, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2) },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2),
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipLabel: { color: colors.text, fontSize: 14 },
  chipLabelSelected: { color: '#ffffff', fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2),
    fontSize: 15,
    color: colors.text,
  },
  notesInput: { minHeight: 140, textAlignVertical: 'top' },
});
