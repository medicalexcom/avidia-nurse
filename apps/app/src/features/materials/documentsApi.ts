import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  DocumentType,
  IndexStatus,
  KnowledgeStatus,
  MaterialExtension,
  ProcessingStatus,
} from '@avidia/domain';

/**
 * Data access for course-material document rows (M3).
 *
 * Documents inherit ownership through their course (RLS), uploaded_by must be
 * the caller (enforced in the INSERT policy), and course_id/uploaded_by are
 * insert-only at the grant level, so documents can never be reparented. The
 * stored object itself lives in the private `course-materials` bucket — see
 * materialStorage.ts. This module never touches Storage.
 */

export interface DocumentRow {
  id: string;
  course_id: string;
  uploaded_by: string;
  filename: string;
  original_filename: string;
  mime_type: string;
  file_extension: MaterialExtension;
  file_size: number;
  storage_key: string | null;
  document_type: DocumentType;
  processing_status: ProcessingStatus;
  /** M5 semantic-indexing lifecycle; drives the "Ready to study" label. */
  index_status: IndexStatus;
  /** M6 concept-extraction lifecycle (internal; failures never block reading). */
  knowledge_status: KnowledgeStatus;
  error_message: string | null;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentInsert {
  course_id: string;
  uploaded_by: string;
  filename: string;
  original_filename: string;
  mime_type: string;
  file_extension: MaterialExtension;
  file_size: number;
  document_type: DocumentType;
  content_hash: string | null;
}

/** Documents of a course, newest first. */
export async function listDocuments(
  client: SupabaseClient,
  courseId: string
): Promise<DocumentRow[]> {
  const { data, error } = await client
    .from('documents')
    .select('*')
    .eq('course_id', courseId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as DocumentRow[];
}

/** Create the metadata row first (status 'uploading'); storage_key comes later. */
export async function createDocumentRow(
  client: SupabaseClient,
  input: DocumentInsert
): Promise<DocumentRow> {
  const { data, error } = await client.from('documents').insert(input).select().single();
  if (error) throw error;
  return data as DocumentRow;
}

/** Mark the row storage-complete: record the object key, status 'uploaded'. */
export async function markDocumentUploaded(
  client: SupabaseClient,
  documentId: string,
  storageKey: string
): Promise<void> {
  const { error } = await client
    .from('documents')
    .update({ storage_key: storageKey, processing_status: 'uploaded', error_message: null })
    .eq('id', documentId);
  if (error) throw error;
}

/** Record an upload failure with a student-safe message. */
export async function markDocumentFailed(
  client: SupabaseClient,
  documentId: string,
  message: string
): Promise<void> {
  const { error } = await client
    .from('documents')
    .update({ processing_status: 'failed', error_message: message.slice(0, 500) })
    .eq('id', documentId);
  if (error) throw error;
}

/**
 * Ask the worker to process (or re-process) a document. Legal transitions
 * only: uploaded -> queued and failed -> queued (the database trigger rejects
 * anything else, and only the service-role worker may move a document into
 * 'processing' or 'ready').
 */
export async function enqueueDocument(client: SupabaseClient, documentId: string): Promise<void> {
  const { error } = await client
    .from('documents')
    .update({ processing_status: 'queued', error_message: null })
    .eq('id', documentId);
  if (error) throw error;
}

export async function updateDocumentType(
  client: SupabaseClient,
  documentId: string,
  documentType: DocumentType
): Promise<void> {
  const { error } = await client
    .from('documents')
    .update({ document_type: documentType })
    .eq('id', documentId);
  if (error) throw error;
}

export async function deleteDocumentRow(client: SupabaseClient, documentId: string): Promise<void> {
  const { error } = await client.from('documents').delete().eq('id', documentId);
  if (error) throw error;
}

/**
 * Find an existing document in the course that looks like the same file.
 * Prefers the content hash when one exists; falls back to an exact
 * name + size match (native platforms cannot hash yet — ADR-0008).
 */
export async function findDuplicateDocument(
  client: SupabaseClient,
  courseId: string,
  candidate: { contentHash: string | null; originalFilename: string; fileSize: number }
): Promise<DocumentRow | null> {
  if (candidate.contentHash) {
    const { data, error } = await client
      .from('documents')
      .select('*')
      .eq('course_id', courseId)
      .eq('content_hash', candidate.contentHash)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) return data as DocumentRow;
  }
  const { data, error } = await client
    .from('documents')
    .select('*')
    .eq('course_id', courseId)
    .eq('original_filename', candidate.originalFilename)
    .eq('file_size', candidate.fileSize)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as DocumentRow | null) ?? null;
}
