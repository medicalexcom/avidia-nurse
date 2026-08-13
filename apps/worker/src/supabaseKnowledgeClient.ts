import { SupabaseClient } from '@supabase/supabase-js';

import { ExtractionChunk, ExtractionRpcPayload } from '@avidia/knowledge';
import { describeLocator, SourceLocator } from '@avidia/rag';

import { ExtractableDocument, KnowledgeClient } from './knowledge';

/**
 * Supabase-backed KnowledgeClient (M6). Service-role only, like the M4/M5
 * worker clients. All persistence goes through the apply_concept_extraction
 * RPC (worker-only, security definer) — the worker never writes concept
 * tables directly, so partial writes cannot exist. Logs nothing here; callers
 * log ids and counts only.
 */

interface ChunkRow {
  id: string;
  content: string;
  source_locator: SourceLocator | null;
}

export function createSupabaseKnowledgeClient(client: SupabaseClient): KnowledgeClient {
  return {
    async claimExtractableDocument(): Promise<ExtractableDocument | null> {
      // Oldest fully-indexed document awaiting extraction first.
      const { data: candidates, error: findError } = await client
        .from('documents')
        .select('id, knowledge_attempts, knowledge_fingerprint')
        .eq('processing_status', 'ready')
        .eq('index_status', 'indexed')
        .eq('knowledge_status', 'pending')
        .order('updated_at', { ascending: true })
        .limit(1);
      if (findError) throw findError;
      const candidate = (candidates ?? [])[0] as
        | { id: string; knowledge_attempts: number; knowledge_fingerprint: string | null }
        | undefined;
      if (!candidate) return null;

      // Optimistic claim: only wins if the row is still pending and indexed.
      const { data: claimed, error: claimError } = await client
        .from('documents')
        .update({
          knowledge_status: 'extracting',
          knowledge_attempts: candidate.knowledge_attempts + 1,
        })
        .eq('id', candidate.id)
        .eq('knowledge_status', 'pending')
        .eq('index_status', 'indexed')
        .eq('processing_status', 'ready')
        .select('id, knowledge_fingerprint');
      if (claimError) throw claimError;
      const row = (claimed ?? [])[0] as
        { id: string; knowledge_fingerprint: string | null } | undefined;
      if (!row) return null; // another worker won the race
      return { id: row.id, knowledgeFingerprint: row.knowledge_fingerprint };
    },

    async loadExtractionChunks(documentId: string): Promise<ExtractionChunk[]> {
      const { data, error } = await client
        .from('source_chunks')
        .select('id, content, source_locator')
        .eq('document_id', documentId)
        .order('ordinal', { ascending: true });
      if (error) throw error;
      return ((data ?? []) as ChunkRow[]).map((row) => ({
        id: row.id,
        content: row.content,
        locator: row.source_locator ? describeLocator(row.source_locator) : 'source material',
      }));
    },

    async applyExtraction(documentId: string, payload: ExtractionRpcPayload) {
      const { data, error } = await client.rpc('apply_concept_extraction', {
        p_document_id: documentId,
        p_payload: payload,
      });
      if (error) throw error;
      const counters = (data ?? {}) as {
        new_concepts?: number;
        links?: number;
        relationships?: number;
        pruned?: number;
      };
      return {
        newConcepts: counters.new_concepts ?? 0,
        links: counters.links ?? 0,
        relationships: counters.relationships ?? 0,
        pruned: counters.pruned ?? 0,
      };
    },

    async markKnowledgeReady(documentId: string, fingerprint: string): Promise<void> {
      const { error } = await client
        .from('documents')
        .update({
          knowledge_status: 'ready',
          knowledge_detail: null,
          knowledge_fingerprint: fingerprint,
          knowledge_at: new Date().toISOString(),
        })
        .eq('id', documentId)
        .eq('knowledge_status', 'extracting');
      if (error) throw error;
    },

    async markKnowledgeFailed(documentId: string, detail: string): Promise<void> {
      const { error } = await client
        .from('documents')
        .update({
          knowledge_status: 'failed',
          knowledge_detail: detail.slice(0, 2000),
        })
        .eq('id', documentId)
        .eq('knowledge_status', 'extracting');
      if (error) throw error;
    },

    async recoverStaleKnowledge(staleBeforeIso: string): Promise<number> {
      // Back to 'pending' (not 'failed'): extraction is internal and
      // retryable; there is no student action to take, so retry silently.
      const { data, error } = await client
        .from('documents')
        .update({ knowledge_status: 'pending' })
        .eq('knowledge_status', 'extracting')
        .lt('updated_at', staleBeforeIso)
        .select('id');
      if (error) throw error;
      return (data ?? []).length;
    },
  };
}
