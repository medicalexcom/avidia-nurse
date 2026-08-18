import { SupabaseClient } from '@supabase/supabase-js';

import {
  GenerationChunk,
  GenerationConcept,
  QuestionGenerationRpcPayload,
} from '@avidia/assessment';
import { describeLocator, SourceLocator } from '@avidia/rag';

import { GenerableDocument, GenerationInputs, QuestionsClient } from './questions';

/**
 * Supabase-backed QuestionsClient (M7). Service-role only, like the M4/M5/M6
 * worker clients. All persistence goes through the apply_question_generation
 * RPC (worker-only, security definer) — the worker never writes question
 * tables directly, so partial writes cannot exist. Logs nothing here; callers
 * log ids and counts only.
 */

interface ChunkRow {
  id: string;
  content: string;
  source_locator: SourceLocator | null;
}

interface ConceptSourceRow {
  chunk_id: string;
  concepts: {
    normalized_key: string;
    canonical_name: string;
    concept_type: string;
    emphasis_score: number;
    status: string;
  } | null;
}

export function createSupabaseQuestionsClient(client: SupabaseClient): QuestionsClient {
  return {
    async claimGenerableDocument(): Promise<GenerableDocument | null> {
      // Oldest knowledge-ready document awaiting question generation first.
      const { data: candidates, error: findError } = await client
        .from('documents')
        .select('id, question_attempts_count, question_fingerprint')
        .eq('knowledge_status', 'ready')
        .eq('question_status', 'pending')
        .order('updated_at', { ascending: true })
        .limit(1);
      if (findError) throw findError;
      const candidate = (candidates ?? [])[0] as
        | { id: string; question_attempts_count: number; question_fingerprint: string | null }
        | undefined;
      if (!candidate) return null;

      // Optimistic claim: only wins if the row is still pending and knowledge-ready.
      const { data: claimed, error: claimError } = await client
        .from('documents')
        .update({
          question_status: 'generating',
          question_attempts_count: candidate.question_attempts_count + 1,
        })
        .eq('id', candidate.id)
        .eq('question_status', 'pending')
        .eq('knowledge_status', 'ready')
        .select('id, question_fingerprint');
      if (claimError) throw claimError;
      const row = (claimed ?? [])[0] as
        { id: string; question_fingerprint: string | null } | undefined;
      if (!row) return null; // another worker won the race
      return { id: row.id, questionFingerprint: row.question_fingerprint };
    },

    async loadGenerationInputs(documentId: string): Promise<GenerationInputs> {
      // Concepts evidenced in THIS document (via concept_sources), active only.
      const { data: conceptRows, error: conceptError } = await client
        .from('concept_sources')
        .select('chunk_id, concepts (normalized_key, canonical_name, concept_type, emphasis_score, status)')
        .eq('document_id', documentId);
      if (conceptError) throw conceptError;
      const byKey = new Map<string, GenerationConcept>();
      const chunksByConcept: Record<string, string[]> = {};
      for (const row of (conceptRows ?? []) as unknown as ConceptSourceRow[]) {
        const concept = row.concepts;
        if (!concept || concept.status !== 'active') continue;
        byKey.set(concept.normalized_key, {
          key: concept.normalized_key,
          name: concept.canonical_name,
          type: concept.concept_type,
          emphasisScore: Number(concept.emphasis_score),
        });
        (chunksByConcept[concept.normalized_key] ??= []).push(row.chunk_id);
      }

      const { data: chunkRows, error: chunkError } = await client
        .from('source_chunks')
        .select('id, content, source_locator')
        .eq('document_id', documentId)
        .order('ordinal', { ascending: true });
      if (chunkError) throw chunkError;
      const chunks: GenerationChunk[] = ((chunkRows ?? []) as ChunkRow[]).map((row) => ({
        id: row.id,
        content: row.content,
        locator: row.source_locator ? describeLocator(row.source_locator) : 'source material',
      }));

      return { concepts: [...byKey.values()], chunks, chunksByConcept };
    },

    async applyGeneration(documentId: string, payload: QuestionGenerationRpcPayload) {
      const { data, error } = await client.rpc('apply_question_generation', {
        p_document_id: documentId,
        p_payload: payload,
      });
      if (error) throw error;
      const counters = (data ?? {}) as {
        inserted?: number;
        skipped?: number;
        links?: number;
        retired?: number;
      };
      return {
        inserted: counters.inserted ?? 0,
        skipped: counters.skipped ?? 0,
        links: counters.links ?? 0,
        retired: counters.retired ?? 0,
      };
    },

    async markQuestionsReady(documentId: string, fingerprint: string): Promise<void> {
      const { error } = await client
        .from('documents')
        .update({
          question_status: 'ready',
          question_detail: null,
          question_fingerprint: fingerprint,
          question_at: new Date().toISOString(),
        })
        .eq('id', documentId)
        .eq('question_status', 'generating');
      if (error) throw error;
    },

    async markQuestionsFailed(documentId: string, detail: string): Promise<void> {
      const { error } = await client
        .from('documents')
        .update({
          question_status: 'failed',
          question_detail: detail.slice(0, 2000),
        })
        .eq('id', documentId)
        .eq('question_status', 'generating');
      if (error) throw error;
    },

    async recoverStaleQuestions(staleBeforeIso: string): Promise<number> {
      // Back to 'pending' (not 'failed'): generation is internal and
      // retryable; there is no student action to take, so retry silently.
      const { data, error } = await client
        .from('documents')
        .update({ question_status: 'pending' })
        .eq('question_status', 'generating')
        .lt('updated_at', staleBeforeIso)
        .select('id');
      if (error) throw error;
      return (data ?? []).length;
    },
  };
}
