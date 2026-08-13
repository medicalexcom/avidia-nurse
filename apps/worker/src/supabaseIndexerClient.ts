import { SupabaseClient } from '@supabase/supabase-js';

import { ExtractedSection, MaterialExtension, SectionType } from '@avidia/domain';
import { EmbeddingProvider, RagChunk } from '@avidia/rag';

import { IndexableDocument, IndexerClient } from './indexer';

/**
 * Supabase-backed IndexerClient (M5). Service-role only, like the M4 worker
 * client. Logs nothing here; callers log ids and counts only. Embedding
 * vectors are serialized in pgvector's '[v1,v2,…]' text form and cast inside
 * the replace_source_chunks RPC — raw vectors never travel to any client.
 */

interface SectionRow {
  section_type: SectionType;
  sequence: number;
  page_number: number | null;
  slide_number: number | null;
  heading: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
}

/** pgvector text literal: '[0.1,0.2,…]'. */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

export function createSupabaseIndexerClient(
  client: SupabaseClient,
  embeddings: EmbeddingProvider
): IndexerClient {
  const metadata = embeddings.metadata();
  return {
    async claimIndexableDocument(): Promise<IndexableDocument | null> {
      // Oldest ready-and-unindexed document first.
      const { data: candidates, error: findError } = await client
        .from('documents')
        .select('id, index_attempts')
        .eq('processing_status', 'ready')
        .eq('index_status', 'pending')
        .order('updated_at', { ascending: true })
        .limit(1);
      if (findError) throw findError;
      const candidate = (candidates ?? [])[0] as { id: string; index_attempts: number } | undefined;
      if (!candidate) return null;

      // Optimistic claim: only wins if the row is still pending.
      const { data: claimed, error: claimError } = await client
        .from('documents')
        .update({
          index_status: 'indexing',
          index_attempts: candidate.index_attempts + 1,
        })
        .eq('id', candidate.id)
        .eq('index_status', 'pending')
        .eq('processing_status', 'ready')
        .select('id, file_extension');
      if (claimError) throw claimError;
      const row = (claimed ?? [])[0] as
        { id: string; file_extension: MaterialExtension } | undefined;
      if (!row) return null; // another indexer won the race
      return { id: row.id, fileExtension: row.file_extension };
    },

    async loadSections(documentId: string): Promise<ExtractedSection[]> {
      const { data, error } = await client
        .from('document_sections')
        .select('section_type, sequence, page_number, slide_number, heading, content, metadata')
        .eq('document_id', documentId)
        .order('sequence', { ascending: true });
      if (error) throw error;
      return ((data ?? []) as SectionRow[]).map((row) => ({
        sectionType: row.section_type,
        sequence: row.sequence,
        pageNumber: row.page_number,
        slideNumber: row.slide_number,
        heading: row.heading,
        content: row.content,
        metadata: row.metadata,
      }));
    },

    async replaceChunks(
      documentId: string,
      chunks: RagChunk[],
      vectors: number[][]
    ): Promise<number> {
      const payload = chunks.map((chunk, index) => ({
        ordinal: chunk.ordinal,
        content: chunk.content,
        token_estimate: chunk.tokenEstimate,
        source_locator: chunk.sourceLocator,
        section_start: chunk.sectionStart,
        section_end: chunk.sectionEnd,
        embedding: toVectorLiteral(vectors[index]!),
        embedding_provider: metadata.provider,
        embedding_model: metadata.model,
        embedding_version: metadata.version,
      }));
      const { data, error } = await client.rpc('replace_source_chunks', {
        p_document_id: documentId,
        p_chunks: payload,
      });
      if (error) throw error;
      return typeof data === 'number' ? data : chunks.length;
    },

    async markIndexed(documentId: string): Promise<void> {
      const { error } = await client
        .from('documents')
        .update({
          index_status: 'indexed',
          index_detail: null,
          indexed_at: new Date().toISOString(),
          // Chunks just changed, so previously extracted concept evidence is
          // out of date: queue the M6 knowledge stage to re-derive it
          // (spec O — never leave stale concept-source links silently active).
          knowledge_status: 'pending',
          knowledge_detail: null,
        })
        .eq('id', documentId)
        .eq('index_status', 'indexing');
      if (error) throw error;
    },

    async markIndexFailed(documentId: string, detail: string): Promise<void> {
      const { error } = await client
        .from('documents')
        .update({
          index_status: 'failed',
          index_detail: detail.slice(0, 2000),
        })
        .eq('id', documentId)
        .eq('index_status', 'indexing');
      if (error) throw error;
    },

    async recoverStaleIndexing(staleBeforeIso: string): Promise<number> {
      // Back to 'pending' (not 'failed'): indexing is internal and retryable;
      // there is no student action to take, so retry silently.
      const { data, error } = await client
        .from('documents')
        .update({ index_status: 'pending' })
        .eq('index_status', 'indexing')
        .lt('updated_at', staleBeforeIso)
        .select('id');
      if (error) throw error;
      return (data ?? []).length;
    },
  };
}
