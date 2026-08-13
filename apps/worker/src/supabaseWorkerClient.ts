import { createClient, SupabaseClient } from '@supabase/supabase-js';

import { ExtractedSection, MaterialExtension } from '@avidia/domain';

import { GENERIC_FAILURE_MESSAGE } from './messages';
import { ClaimedDocument, WorkerClient } from './processor';

/**
 * Supabase-backed WorkerClient (spec J/O).
 *
 * Runs with the service-role key (SUPABASE_SERVICE_ROLE_KEY) — server-side
 * only, never an EXPO_PUBLIC_* variable, never bundled into the app. RLS is
 * bypassed by the service role, but every mutation here is scoped by primary
 * key and guarded by the status-transition trigger, so the worker can only
 * perform legal state-machine moves. Nothing here logs document content,
 * storage keys, or credentials.
 */

/** Same bucket the app uploads to (ADR-0008). */
export const MATERIALS_BUCKET = 'course-materials';

interface DocumentClaimRow {
  id: string;
  storage_key: string | null;
  file_extension: MaterialExtension;
}

function toSnakeSections(sections: ExtractedSection[]): Record<string, unknown>[] {
  return sections.map((section) => ({
    section_type: section.sectionType,
    sequence: section.sequence,
    page_number: section.pageNumber,
    slide_number: section.slideNumber,
    heading: section.heading,
    content: section.content,
    metadata: section.metadata,
  }));
}

export function createSupabaseWorkerClient(client: SupabaseClient): WorkerClient {
  return {
    async claimQueuedDocument(): Promise<ClaimedDocument | null> {
      // Oldest queued document first.
      const { data: candidates, error: findError } = await client
        .from('documents')
        .select('id, processing_attempts')
        .eq('processing_status', 'queued')
        .order('updated_at', { ascending: true })
        .limit(1);
      if (findError) throw findError;
      const candidate = (candidates ?? [])[0] as
        { id: string; processing_attempts: number } | undefined;
      if (!candidate) return null;

      // Optimistic claim: only wins if the row is still queued.
      const { data: claimed, error: claimError } = await client
        .from('documents')
        .update({
          processing_status: 'processing',
          processing_attempts: candidate.processing_attempts + 1,
        })
        .eq('id', candidate.id)
        .eq('processing_status', 'queued')
        .select('id, storage_key, file_extension');
      if (claimError) throw claimError;
      const row = (claimed ?? [])[0] as DocumentClaimRow | undefined;
      if (!row) return null; // another worker won the race
      return { id: row.id, storageKey: row.storage_key, fileExtension: row.file_extension };
    },

    async downloadObject(storageKey: string): Promise<Uint8Array> {
      const { data, error } = await client.storage.from(MATERIALS_BUCKET).download(storageKey);
      if (error) throw error;
      return new Uint8Array(await data.arrayBuffer());
    },

    async replaceSections(documentId: string, sections: ExtractedSection[]): Promise<number> {
      const { data, error } = await client.rpc('replace_document_sections', {
        p_document_id: documentId,
        p_sections: toSnakeSections(sections),
      });
      if (error) throw error;
      return typeof data === 'number' ? data : sections.length;
    },

    async markReady(documentId: string): Promise<void> {
      const { error } = await client
        .from('documents')
        .update({
          processing_status: 'ready',
          error_message: null,
          processing_detail: null,
          processed_at: new Date().toISOString(),
        })
        .eq('id', documentId)
        .eq('processing_status', 'processing');
      if (error) throw error;
    },

    async markFailed(documentId: string, userMessage: string, detail: string): Promise<void> {
      const { error } = await client
        .from('documents')
        .update({
          processing_status: 'failed',
          error_message: userMessage.slice(0, 500),
          processing_detail: detail.slice(0, 2000),
          processed_at: new Date().toISOString(),
        })
        .eq('id', documentId)
        .eq('processing_status', 'processing');
      if (error) throw error;
    },

    async recoverStaleProcessing(staleBeforeIso: string): Promise<number> {
      const { data, error } = await client
        .from('documents')
        .update({
          processing_status: 'failed',
          error_message: GENERIC_FAILURE_MESSAGE,
          processing_detail: 'stale processing recovered by worker sweep',
          processed_at: new Date().toISOString(),
        })
        .eq('processing_status', 'processing')
        .lt('updated_at', staleBeforeIso)
        .select('id');
      if (error) throw error;
      return (data ?? []).length;
    },
  };
}

/** Build the service-role Supabase client from server-side env vars. */
export function supabaseClientFromEnv(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      'Worker requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.'
    );
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
