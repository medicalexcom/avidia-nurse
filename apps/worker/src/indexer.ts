import { ExtractedSection, MaterialExtension } from '@avidia/domain';
import { chunkSections, EmbeddingProvider, RagChunk } from '@avidia/rag';

/**
 * Semantic indexing stage (M5, spec I/J/V).
 *
 * A SEPARATE lifecycle from M4 extraction, tracked in documents.index_status
 * (pending → indexing → indexed | failed) so extraction states stay exactly
 * as M4 defined them. A document becomes indexable only once extraction has
 * made it 'ready'; re-extraction resets index_status to 'pending', so chunks
 * are always rebuilt from the latest sections — never stale.
 *
 * Same discipline as the processor: optimistic compare-and-set claims (two
 * indexers never embed the same document twice — spec V's duplicate-embedding
 * guard), atomic chunk replacement via the replace_source_chunks RPC
 * (idempotent re-indexing), student-safe failure states, stale sweep.
 */

/** Minimal projection of a documents row the indexer needs. */
export interface IndexableDocument {
  id: string;
  fileExtension: MaterialExtension;
}

export interface IndexerClient {
  /**
   * Atomically claim one document with processing_status='ready' AND
   * index_status='pending': set index_status='indexing' (bumping
   * index_attempts) only if it is still pending. Returns null when there is
   * nothing to index or another indexer won the race.
   */
  claimIndexableDocument(): Promise<IndexableDocument | null>;
  /** Load the document's M4 sections in sequence order. */
  loadSections(documentId: string): Promise<ExtractedSection[]>;
  /**
   * Atomically replace all chunks of a document (delete + insert in one
   * transaction via the replace_source_chunks RPC). Embeddings are aligned
   * with chunks by index. Returns the number of chunks stored.
   */
  replaceChunks(documentId: string, chunks: RagChunk[], embeddings: number[][]): Promise<number>;
  /** indexing -> indexed; stamps indexed_at, clears index_detail. */
  markIndexed(documentId: string): Promise<void>;
  /** indexing -> failed. detail is internal-only (index_detail). */
  markIndexFailed(documentId: string, detail: string): Promise<void>;
  /**
   * Recover documents stuck in 'indexing' (e.g. an indexer crashed) by
   * resetting them to 'pending' so they are retried. Returns the count.
   */
  recoverStaleIndexing(staleBeforeIso: string): Promise<number>;
}

export type IndexOutcome =
  | { status: 'idle' }
  | { status: 'indexed'; documentId: string; chunkCount: number; tokenEstimate: number }
  | { status: 'failed'; documentId: string };

/** Documents stuck in 'indexing' longer than this are considered stale. */
export const STALE_INDEXING_MS = 15 * 60 * 1000;

/**
 * Claim and fully index one ready document: sections → semantic chunks →
 * batched embeddings → atomic chunk replacement. Never throws for
 * per-document problems; failures are recorded on the row so the queue keeps
 * draining. A document is 'indexed' only after its chunks are stored.
 */
export async function indexNextDocument(
  client: IndexerClient,
  embeddings: EmbeddingProvider
): Promise<IndexOutcome> {
  const doc = await client.claimIndexableDocument();
  if (!doc) {
    return { status: 'idle' };
  }
  try {
    const sections = await client.loadSections(doc.id);
    const chunks = chunkSections(sections, doc.fileExtension);
    // Batched by the provider internally (spec V); zero chunks is a legal
    // outcome (an empty-but-ready document) and clears any stale chunks.
    const vectors = await embeddings.embedDocuments(chunks.map((chunk) => chunk.content));
    if (vectors.length !== chunks.length) {
      throw new Error(`embedded ${vectors.length} of ${chunks.length} chunks`);
    }
    const chunkCount = await client.replaceChunks(doc.id, chunks, vectors);
    await client.markIndexed(doc.id);
    const tokenEstimate = chunks.reduce((sum, chunk) => sum + chunk.tokenEstimate, 0);
    return { status: 'indexed', documentId: doc.id, chunkCount, tokenEstimate };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      await client.markIndexFailed(doc.id, detail.slice(0, 2000));
    } catch {
      // Even the failure write failed; the row stays 'indexing' and will be
      // reset to 'pending' by recoverStaleIndexing.
    }
    return { status: 'failed', documentId: doc.id };
  }
}

/** Index until nothing is pending; returns the outcomes in order. */
export async function drainIndexQueue(
  client: IndexerClient,
  embeddings: EmbeddingProvider
): Promise<IndexOutcome[]> {
  const outcomes: IndexOutcome[] = [];
  for (;;) {
    const outcome = await indexNextDocument(client, embeddings);
    if (outcome.status === 'idle') {
      return outcomes;
    }
    outcomes.push(outcome);
  }
}
