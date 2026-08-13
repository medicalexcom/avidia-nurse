/**
 * Course-material (document) domain rules — M3.
 *
 * Pure logic only: supported formats, MIME/extension/size validation, the
 * processing-status state machine, and storage-key generation. No I/O, no
 * React, no Supabase. Screens and services consume these rules; they never
 * re-implement them.
 */

/** Supported upload formats and the MIME types we trust for each. */
export const SUPPORTED_MATERIAL_FORMATS = {
  pdf: ['application/pdf'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  txt: ['text/plain'],
} as const;

export type MaterialExtension = keyof typeof SUPPORTED_MATERIAL_FORMATS;

export const SUPPORTED_MATERIAL_EXTENSIONS = Object.keys(
  SUPPORTED_MATERIAL_FORMATS
) as MaterialExtension[];

/**
 * Default upload cap: 50 MiB. Chosen because realistic nursing-school
 * materials (lecture PDFs, PowerPoint decks with images, study guides) sit
 * well under this, while video files — which we do not support — are the
 * usual reason for larger uploads. Configurable per call site, but the
 * database and bucket enforce this value as a hard ceiling (ADR-0008).
 */
export const DEFAULT_MAX_MATERIAL_BYTES = 50 * 1024 * 1024;

export const DOCUMENT_TYPES = [
  'lecture',
  'study_guide',
  'course_objectives',
  'notes',
  'textbook_excerpt',
  'other',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  lecture: 'Lecture',
  study_guide: 'Study guide',
  course_objectives: 'Course objectives',
  notes: 'Notes',
  textbook_excerpt: 'Textbook excerpt',
  other: 'Other',
};

/**
 * Processing-status state machine.
 *
 * M3 (client-driven):
 *   uploading -> uploaded   object stored; row updated with storage_key
 *   uploading -> failed     storage upload failed (error_message set)
 *   failed    -> uploading  student retries the upload
 *
 * M4 (future server-side worker; defined now so the schema is stable):
 *   uploaded  -> queued -> processing -> ready | failed
 *
 * M3 deliberately stops at 'uploaded': no extraction has happened, and we do
 * not pretend otherwise.
 */
export const PROCESSING_STATUSES = [
  'uploading',
  'uploaded',
  'queued',
  'processing',
  'ready',
  'failed',
] as const;

export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

const STATUS_TRANSITIONS: Record<ProcessingStatus, ProcessingStatus[]> = {
  uploading: ['uploaded', 'failed'],
  uploaded: ['queued'],
  queued: ['processing'],
  processing: ['ready', 'failed'],
  ready: [],
  failed: ['uploading', 'queued'],
};

export function canTransitionStatus(from: ProcessingStatus, to: ProcessingStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

export const PROCESSING_STATUS_LABELS: Record<ProcessingStatus, string> = {
  uploading: 'Uploading…',
  uploaded: 'Uploaded',
  queued: 'Queued',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Upload failed',
};

/** Lower-cased extension of a filename, without the dot; null when absent. */
export function fileExtensionOf(filename: string): string | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename.trim());
  return match ? match[1]!.toLowerCase() : null;
}

export interface MaterialFileCandidate {
  filename: string;
  /** MIME type reported by the picker; may be missing or generic. */
  mimeType: string | null;
  /** Size in bytes; may be unknown on some platforms until read. */
  size: number | null;
}

export type MaterialValidation =
  { ok: true; extension: MaterialExtension; mimeType: string } | { ok: false; error: string };

/**
 * Validate a picked file. The extension must be supported, and when the
 * platform reports a concrete MIME type it must agree with the extension —
 * we do not trust the filename alone, but we also tolerate pickers that
 * report nothing or the generic `application/octet-stream`. The final word
 * on MIME belongs to the bucket's server-side `allowed_mime_types` list.
 */
export function validateMaterialFile(
  candidate: MaterialFileCandidate,
  maxBytes: number = DEFAULT_MAX_MATERIAL_BYTES
): MaterialValidation {
  const extension = fileExtensionOf(candidate.filename);
  if (!extension || !(extension in SUPPORTED_MATERIAL_FORMATS)) {
    return {
      ok: false,
      error:
        'That file type is not supported. Please choose a PDF, PPTX, DOCX or TXT file. ' +
        'Legacy .doc and .ppt files should be re-saved in the modern format first.',
    };
  }
  const supported = extension as MaterialExtension;
  const expectedMimes: readonly string[] = SUPPORTED_MATERIAL_FORMATS[supported];

  const reported = candidate.mimeType?.trim().toLowerCase() ?? '';
  const mimeIsGeneric = reported === '' || reported === 'application/octet-stream';
  if (!mimeIsGeneric && !expectedMimes.includes(reported)) {
    return {
      ok: false,
      error: `That file does not look like a valid .${supported} file. Please check the file and try again.`,
    };
  }

  if (candidate.size !== null) {
    if (candidate.size <= 0) {
      return { ok: false, error: 'That file appears to be empty.' };
    }
    if (candidate.size > maxBytes) {
      return {
        ok: false,
        error: `That file is too large (${formatBytes(candidate.size)}). The limit is ${formatBytes(maxBytes)}.`,
      };
    }
  }

  return { ok: true, extension: supported, mimeType: expectedMimes[0]! };
}

/**
 * Sanitize a filename for use inside a storage key: strip path separators and
 * control characters, collapse whitespace, and cap the length while keeping
 * the extension. Display always uses original_filename; this only shapes the
 * object path.
 */
export function sanitizeMaterialFilename(original: string): string {
  const extension = fileExtensionOf(original);
  const stem = extension
    ? original.trim().slice(0, original.trim().length - extension.length - 1)
    : original.trim();
  const cleanedStem = stem
    // eslint-disable-next-line no-control-regex -- deliberately stripping control chars
    .replace(/[\u0000-\u001f\u007f/\\?#%*:|"<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .trim();
  const safeStem = cleanedStem.length > 0 ? cleanedStem : 'file';
  return extension ? `${safeStem}.${extension}` : safeStem;
}

/**
 * Object path convention (ADR-0008): {user_id}/{course_id}/{document_id}/{filename}.
 * The first segment is what storage policies authorize on; the database also
 * CHECKs that a document row's storage_key matches its own ownership columns.
 */
export function buildStorageKey(
  userId: string,
  courseId: string,
  documentId: string,
  filename: string
): string {
  return `${userId}/${courseId}/${documentId}/${sanitizeMaterialFilename(filename)}`;
}

/** Human-friendly byte size, e.g. "2.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
