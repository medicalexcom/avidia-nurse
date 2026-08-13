import {
  batchExtractionChunks,
  computeKnowledgeFingerprint,
  ConceptExtractionProvider,
  ExtractionChunk,
  ExtractionRpcPayload,
  RawExtraction,
  refineExtraction,
  toRpcPayload,
} from '@avidia/knowledge';

/**
 * Concept-extraction stage (M6 spec N/O/S/T).
 *
 * The THIRD independent document lifecycle, tracked in
 * documents.knowledge_status (pending → extracting → ready | failed),
 * alongside M4 processing_status and M5 index_status. A document becomes
 * extractable only once it is BOTH 'ready' (extracted) and 'indexed'
 * (chunked): concepts are grounded in the same source_chunks retrieval uses,
 * so provenance ids line up across milestones. Re-indexing resets
 * knowledge_status to 'pending' — concept evidence is always derived from the
 * current chunks, never stale ones (spec O).
 *
 * Failure isolation (spec T): a concept-extraction failure marks ONLY
 * knowledge_status='failed'; the document stays fully readable and
 * retrievable, and the stage is retryable.
 *
 * Cost control (spec S): a SHA-256 fingerprint over provider/model/prompt
 * version/extraction version plus the exact chunk ids and contents is
 * compared with the stored fingerprint before any AI call. Unchanged
 * material never pays for extraction again — the claim is simply marked
 * ready.
 */

/** Minimal projection of a documents row the knowledge stage needs. */
export interface ExtractableDocument {
  id: string;
  /** documents.knowledge_fingerprint from the previous successful run. */
  knowledgeFingerprint: string | null;
}

export interface KnowledgeClient {
  /**
   * Atomically claim one document with processing_status='ready' AND
   * index_status='indexed' AND knowledge_status='pending': set
   * knowledge_status='extracting' (bumping knowledge_attempts) only if it is
   * still pending. Returns null when there is nothing to extract or another
   * worker won the race.
   */
  claimExtractableDocument(): Promise<ExtractableDocument | null>;
  /** Load the document's source chunks (id, content, human locator) in order. */
  loadExtractionChunks(documentId: string): Promise<ExtractionChunk[]>;
  /**
   * Atomically withdraw-and-replace the document's concept evidence via the
   * apply_concept_extraction RPC (delete this document's links + chunk-backed
   * relationships, upsert concepts/aliases, insert links, prune orphans,
   * recompute emphasis — one transaction). Returns the RPC counters.
   */
  applyExtraction(
    documentId: string,
    payload: ExtractionRpcPayload
  ): Promise<{ newConcepts: number; links: number; relationships: number; pruned: number }>;
  /** extracting -> ready; stores the fingerprint, stamps knowledge_at. */
  markKnowledgeReady(documentId: string, fingerprint: string): Promise<void>;
  /** extracting -> failed. detail is internal-only (knowledge_detail). */
  markKnowledgeFailed(documentId: string, detail: string): Promise<void>;
  /** Reset documents stuck in 'extracting' back to 'pending'. Returns count. */
  recoverStaleKnowledge(staleBeforeIso: string): Promise<number>;
}

export type KnowledgeOutcome =
  | { status: 'idle' }
  | { status: 'skipped'; documentId: string } // fingerprint unchanged, no AI call
  | {
      status: 'extracted';
      documentId: string;
      concepts: number;
      links: number;
      relationships: number;
    }
  | { status: 'failed'; documentId: string };

/** Documents stuck in 'extracting' longer than this are considered stale. */
export const STALE_KNOWLEDGE_MS = 15 * 60 * 1000;

/**
 * Claim and fully process one document: chunks → fingerprint gate → batched
 * provider extraction → deterministic refinement → atomic RPC persistence.
 * Never throws for per-document problems; failures are recorded on the row
 * (knowledge lifecycle only) so the queue keeps draining.
 */
export async function extractNextDocument(
  client: KnowledgeClient,
  provider: ConceptExtractionProvider
): Promise<KnowledgeOutcome> {
  const doc = await client.claimExtractableDocument();
  if (!doc) {
    return { status: 'idle' };
  }
  try {
    const chunks = await client.loadExtractionChunks(doc.id);
    const metadata = provider.metadata();
    const fingerprint = computeKnowledgeFingerprint(chunks, metadata);
    if (doc.knowledgeFingerprint === fingerprint) {
      // Nothing changed since the last successful extraction (spec S): the
      // stored concepts are still valid, so skip the provider entirely.
      await client.markKnowledgeReady(doc.id, fingerprint);
      return { status: 'skipped', documentId: doc.id };
    }

    const batches = batchExtractionChunks(chunks);
    const merged: RawExtraction = { concepts: [], relationships: [] };
    let offset = 0;
    for (const batch of batches) {
      const extraction = await provider.extract(batch);
      // Re-base batch-local chunk indexes onto the full chunk list so
      // refinement maps every citation to the right source_chunks id.
      for (const concept of extraction.concepts) {
        merged.concepts.push({
          ...concept,
          chunk_indexes: concept.chunk_indexes.map((index) => index + offset),
        });
      }
      for (const relationship of extraction.relationships) {
        merged.relationships.push({
          ...relationship,
          chunk_index: relationship.chunk_index + offset,
        });
      }
      offset += batch.length;
    }

    const refined = refineExtraction(merged, chunks);
    const result = await client.applyExtraction(doc.id, toRpcPayload(refined, metadata));
    await client.markKnowledgeReady(doc.id, fingerprint);
    return {
      status: 'extracted',
      documentId: doc.id,
      concepts: result.newConcepts,
      links: result.links,
      relationships: result.relationships,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      await client.markKnowledgeFailed(doc.id, detail.slice(0, 2000));
    } catch {
      // Even the failure write failed; the row stays 'extracting' and will be
      // reset to 'pending' by recoverStaleKnowledge.
    }
    return { status: 'failed', documentId: doc.id };
  }
}

/** Extract until nothing is pending; returns the outcomes in order. */
export async function drainKnowledgeQueue(
  client: KnowledgeClient,
  provider: ConceptExtractionProvider
): Promise<KnowledgeOutcome[]> {
  const outcomes: KnowledgeOutcome[] = [];
  for (;;) {
    const outcome = await extractNextDocument(client, provider);
    if (outcome.status === 'idle') {
      return outcomes;
    }
    outcomes.push(outcome);
  }
}
