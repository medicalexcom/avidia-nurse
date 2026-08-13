import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildStorageKey,
  DEFAULT_MAX_MATERIAL_BYTES,
  sanitizeMaterialFilename,
  validateMaterialFile,
  type DocumentType,
} from '@avidia/domain';
import { sha256Hex } from './contentHash';
import {
  createDocumentRow,
  deleteDocumentRow,
  enqueueDocument,
  findDuplicateDocument,
  listDocuments,
  markDocumentFailed,
  markDocumentUploaded,
  type DocumentRow,
} from './documentsApi';
import { removeMaterialObjects, uploadMaterialObject } from './materialStorage';

/**
 * Upload orchestration (M3, spec O/P).
 *
 * Order of operations — chosen so nothing is ever silently inconsistent:
 *   1. validate (domain rules)              -> clear student-facing error
 *   2. duplicate check (hash, else name+size)
 *   3. INSERT document row, status 'uploading'
 *   4. upload object to private storage
 *   5. UPDATE row: storage_key + status 'uploaded'
 * A failure at step 4/5 marks the row 'failed' with a safe message; the
 * student sees the failed material and can delete it or retry (retry deletes
 * the failed row and starts a fresh upload with the re-picked file).
 *
 * M4: after a successful upload the document is enqueued for extraction
 * (uploaded -> queued) on a best-effort basis; the background worker takes it
 * from there (queued -> processing -> ready | failed). If enqueueing fails,
 * the document simply rests at 'uploaded' and the student can press
 * "Process" on the Materials screen.
 */

const UPLOAD_FAILED_MESSAGE =
  'The upload did not complete. Please check your connection and try again.';

export interface UploadRequest {
  userId: string;
  courseId: string;
  file: { name: string; size: number | null; mimeType: string | null; bytes: ArrayBuffer };
  documentType: DocumentType;
  /** Set when the student explicitly chose to upload despite a duplicate. */
  allowDuplicate?: boolean;
  maxBytes?: number;
}

export type UploadOutcome =
  | { kind: 'uploaded'; document: DocumentRow }
  | { kind: 'duplicate'; existing: DocumentRow }
  | { kind: 'invalid'; error: string }
  | { kind: 'failed'; document: DocumentRow; error: string };

export async function uploadMaterial(
  client: SupabaseClient,
  request: UploadRequest
): Promise<UploadOutcome> {
  const validation = validateMaterialFile(
    { filename: request.file.name, mimeType: request.file.mimeType, size: request.file.size },
    request.maxBytes ?? DEFAULT_MAX_MATERIAL_BYTES
  );
  if (!validation.ok) return { kind: 'invalid', error: validation.error };

  const fileSize = request.file.size ?? request.file.bytes.byteLength;
  const contentHash = await sha256Hex(request.file.bytes);

  if (!request.allowDuplicate) {
    const existing = await findDuplicateDocument(client, request.courseId, {
      contentHash,
      originalFilename: request.file.name,
      fileSize,
    });
    if (existing) return { kind: 'duplicate', existing };
  }

  const row = await createDocumentRow(client, {
    course_id: request.courseId,
    uploaded_by: request.userId,
    filename: sanitizeMaterialFilename(request.file.name),
    original_filename: request.file.name,
    mime_type: validation.mimeType,
    file_extension: validation.extension,
    file_size: fileSize,
    document_type: request.documentType,
    content_hash: contentHash,
  });

  const storageKey = buildStorageKey(request.userId, request.courseId, row.id, request.file.name);
  try {
    await uploadMaterialObject(client, storageKey, request.file.bytes, validation.mimeType);
    await markDocumentUploaded(client, row.id, storageKey);
  } catch {
    // Keep the row so the student can see and manage the failure; best-effort
    // status update (if even that fails, the row stays 'uploading' and the
    // next Materials load surfaces it as incomplete).
    try {
      await markDocumentFailed(client, row.id, UPLOAD_FAILED_MESSAGE);
    } catch {
      // Intentionally swallowed: the original failure is what the student sees.
    }
    return {
      kind: 'failed',
      document: { ...row, processing_status: 'failed', error_message: UPLOAD_FAILED_MESSAGE },
      error: UPLOAD_FAILED_MESSAGE,
    };
  }

  // Best-effort enqueue for extraction (M4). Failure is not an upload
  // failure: the material is safely stored and can be processed later.
  let queued = false;
  try {
    await enqueueDocument(client, row.id);
    queued = true;
  } catch {
    // Intentionally swallowed — the row stays 'uploaded' with a Process action.
  }

  return {
    kind: 'uploaded',
    document: {
      ...row,
      storage_key: storageKey,
      processing_status: queued ? 'queued' : 'uploaded',
    },
  };
}

/** Create a pasted-notes material as a .txt file — no M4 processing involved. */
export function notesToFile(noteTitle: string, text: string): UploadRequest['file'] {
  const encoded = new TextEncoder().encode(text);
  const bytes = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength
  ) as ArrayBuffer;
  const name = sanitizeMaterialFilename(`${noteTitle.trim() || 'Pasted notes'}.txt`);
  return { name, size: encoded.byteLength, mimeType: 'text/plain', bytes };
}

/**
 * Delete a material: storage object first, then the database row.
 *
 * If the object removal succeeds but the row deletion fails, the row remains
 * visible and the student can simply delete again — object removal of a
 * missing key is a no-op, so the retry converges instead of leaving a silent
 * inconsistency. The reverse order would orphan unreachable objects.
 * Future M4/M5 derived artifacts (chunks, embeddings) will hang off
 * documents.id with ON DELETE CASCADE, so this same entry point will remove
 * them automatically (ADR-0008).
 */
export async function deleteMaterial(
  client: SupabaseClient,
  document: Pick<DocumentRow, 'id' | 'storage_key'>
): Promise<void> {
  if (document.storage_key) {
    await removeMaterialObjects(client, [document.storage_key]);
  }
  await deleteDocumentRow(client, document.id);
}

/**
 * Remove all stored objects for a course before the course row is deleted
 * (the row cascade removes document rows, but storage objects are not part
 * of the SQL cascade — this prevents orphaned objects).
 */
export async function removeCourseMaterialObjects(
  client: SupabaseClient,
  courseId: string
): Promise<number> {
  const documents = await listDocuments(client, courseId);
  const keys = documents.map((doc) => doc.storage_key).filter((key): key is string => key !== null);
  await removeMaterialObjects(client, keys);
  return documents.length;
}
