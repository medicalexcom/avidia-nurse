import { ExtractedSection, MaterialExtension } from '@avidia/domain';
import { extractDocument } from '@avidia/ingestion';

import { internalDetailForError, userMessageForError } from './messages';

/**
 * Document-processing worker core (spec H–K, O).
 *
 * The worker is the only actor allowed to move documents into 'processing'
 * and 'ready' (a database trigger reserves those transitions for the service
 * role), and it never trusts client-supplied state: a document is claimed
 * with an optimistic compare-and-set on processing_status = 'queued', so two
 * workers can never process the same document twice.
 *
 * All storage/database I/O goes through the WorkerClient interface. Today it
 * is backed by Supabase polling (Postgres-as-queue); the interface is the
 * seam where a durable queue (e.g. pgmq, SQS) can be swapped in later
 * without touching extraction or state-machine logic (ADR-0010).
 */

/** Minimal projection of a documents row the worker needs. */
export interface ClaimedDocument {
  id: string;
  storageKey: string | null;
  fileExtension: MaterialExtension;
}

export interface WorkerClient {
  /**
   * Atomically claim one queued document: set processing_status='processing'
   * (and bump processing_attempts) only if it is still 'queued'. Returns null
   * when the queue is empty or another worker won the race.
   */
  claimQueuedDocument(): Promise<ClaimedDocument | null>;
  /** Download the stored object bytes for a claimed document. */
  downloadObject(storageKey: string): Promise<Uint8Array>;
  /**
   * Atomically replace all sections of a document (delete + insert in one
   * transaction). This is what makes reprocessing idempotent: rerunning
   * extraction converges to the same rows instead of appending duplicates.
   */
  replaceSections(documentId: string, sections: ExtractedSection[]): Promise<number>;
  /** processing -> ready; clears error fields, stamps processed_at. */
  markReady(documentId: string): Promise<void>;
  /**
   * processing -> failed. userMessage is student-safe (error_message);
   * detail is internal-only (processing_detail).
   */
  markFailed(documentId: string, userMessage: string, detail: string): Promise<void>;
  /**
   * Recover documents stuck in 'processing' (e.g. a worker crashed) by
   * failing them so the student can retry. Returns how many were recovered.
   */
  recoverStaleProcessing(staleBeforeIso: string): Promise<number>;
}

export type ProcessOutcome =
  | { status: 'idle' }
  | { status: 'ready'; documentId: string; sectionCount: number }
  | { status: 'failed'; documentId: string; userMessage: string };

/**
 * Claim and fully process one document. Never throws for per-document
 * problems: any failure is recorded on the row (status 'failed' with a
 * student-safe message) so the queue keeps draining. A document is marked
 * 'ready' only after extraction succeeded AND its sections were stored.
 */
export async function processNextDocument(client: WorkerClient): Promise<ProcessOutcome> {
  const doc = await client.claimQueuedDocument();
  if (!doc) {
    return { status: 'idle' };
  }

  try {
    if (!doc.storageKey) {
      // Defensive: queued rows should always have a stored object.
      throw new Error('claimed document has no storage_key');
    }
    const bytes = await client.downloadObject(doc.storageKey);
    const { sections } = await extractDocument(bytes, doc.fileExtension);
    const sectionCount = await client.replaceSections(doc.id, sections);
    await client.markReady(doc.id);
    return { status: 'ready', documentId: doc.id, sectionCount };
  } catch (error) {
    const userMessage = userMessageForError(error);
    try {
      await client.markFailed(doc.id, userMessage, internalDetailForError(error));
    } catch {
      // Even the failure write failed (e.g. network); the document stays in
      // 'processing' and will be swept by recoverStaleProcessing.
    }
    return { status: 'failed', documentId: doc.id, userMessage };
  }
}

/** Documents stuck in 'processing' longer than this are considered stale. */
export const STALE_PROCESSING_MS = 15 * 60 * 1000;

/** Drain the queue until it is empty; returns the outcomes in order. */
export async function drainQueue(client: WorkerClient): Promise<ProcessOutcome[]> {
  const outcomes: ProcessOutcome[] = [];
  for (;;) {
    const outcome = await processNextDocument(client);
    if (outcome.status === 'idle') {
      return outcomes;
    }
    outcomes.push(outcome);
  }
}
