import {
  computeQuestionFingerprint,
  GenerationChunk,
  GenerationConcept,
  pickGenerationConcepts,
  QuestionGenerationProvider,
  QuestionGenerationRpcPayload,
  toQuestionRpcPayload,
  validateGenerationBatch,
} from '@avidia/assessment';

import { errorMessage } from './messages';

/**
 * Question-generation stage (M7 spec G/I/Y/AD/AE).
 *
 * The FOURTH independent document lifecycle, tracked in
 * documents.question_status (pending -> generating -> ready | failed),
 * alongside M4 processing_status, M5 index_status and M6 knowledge_status. A
 * document becomes generable only once knowledge_status='ready': questions
 * are grounded in the same source_chunks retrieval uses and target the M6
 * concepts, so provenance lines up across milestones. Re-extraction resets
 * question_status to 'pending' - questions always derive from the current
 * concept evidence, never stale knowledge.
 *
 * Failure isolation (spec AE): a generation failure marks ONLY
 * question_status='failed'; reading, retrieval and the knowledge map stay
 * fully usable, and the stage is retryable. Studying never requires a live
 * LLM - sessions draw from already-persisted questions.
 *
 * Cost control (spec Y/AD): a SHA-256 fingerprint over provider/model/prompt
 * version/generation version plus the selected concept keys and the exact
 * chunk ids and contents is compared with the stored fingerprint before any
 * AI call. Unchanged material never pays for generation again.
 *
 * Yield (spec Y/AD, widened): one claimed document is worked in multiple
 * concept batches, not one. Each batch asks for a bounded slice of the
 * document's highest-emphasis concepts and is grounded ONLY in the chunks
 * concept_sources actually links to that slice (never the whole document),
 * so the model's context stays focused instead of drowning in unrelated
 * material. Batches keep running until TARGET_QUESTIONS_PER_DOCUMENT is
 * reached, MAX_GENERATION_BATCHES_PER_DOCUMENT caps the run, or
 * MAX_CONSECUTIVE_EMPTY_BATCHES trips a circuit breaker on unproductive
 * material — whichever comes first. question_status still flips to 'ready'
 * exactly once, after every batch for this claim has run.
 */

/** Minimal projection of a documents row the questions stage needs. */
export interface GenerableDocument {
  id: string;
  /** documents.questionFingerprint from the previous successful run. */
  questionFingerprint: string | null;
}

/** What generation is grounded in: the document's concepts and chunks. */
export interface GenerationInputs {
  concepts: GenerationConcept[];
  chunks: GenerationChunk[];
  /**
   * concept_sources evidence links: concept key -> ids of chunks (within
   * `chunks`) that actually evidence it. Lets one claimed document be worked
   * in several concept batches, each grounded only in the material relevant
   * to it rather than the whole document. A concept with no recorded link
   * (or an entirely empty map, e.g. an older client) falls back to the full
   * chunk set for its batch — evidence scoping is a focus improvement, never
   * a reason to generate ungrounded.
   */
  chunksByConcept: Record<string, string[]>;
}

export interface QuestionsApplyResult {
  inserted: number;
  skipped: number;
  links: number;
  retired: number;
}

export interface QuestionsClient {
  /**
   * Atomically claim one document with knowledge_status='ready' AND
   * question_status='pending': set question_status='generating' (bumping
   * question_attempts_count) only if it is still pending. Returns null when
   * there is nothing to generate or another worker won the race.
   */
  claimGenerableDocument(): Promise<GenerableDocument | null>;
  /** Load the document's evidenced concepts and its source chunks in order. */
  loadGenerationInputs(documentId: string): Promise<GenerationInputs>;
  /**
   * Persist one validated batch atomically via the apply_question_generation
   * RPC (insert questions + options, refresh provenance links, dedup by
   * content hash, retire evidence-less course-grounded questions - one
   * transaction). Returns the RPC counters.
   */
  applyGeneration(
    documentId: string,
    payload: QuestionGenerationRpcPayload
  ): Promise<QuestionsApplyResult>;
  /** generating -> ready; stores the fingerprint, stamps question_at. */
  markQuestionsReady(documentId: string, fingerprint: string): Promise<void>;
  /** generating -> failed. detail is internal-only (question_detail). */
  markQuestionsFailed(documentId: string, detail: string): Promise<void>;
  /** Reset documents stuck in 'generating' back to 'pending'. Returns count. */
  recoverStaleQuestions(staleBeforeIso: string): Promise<number>;
}

export type QuestionsOutcome =
  | { status: 'idle' }
  | { status: 'skipped'; documentId: string } // fingerprint unchanged, no AI call
  | {
      status: 'generated';
      documentId: string;
      inserted: number;
      duplicates: number;
      rejected: number;
      flagged: number;
      links: number;
      /** Number of concept-batch generation calls this claim actually ran. */
      batches: number;
    }
  | { status: 'failed'; documentId: string };

/** Documents stuck in 'generating' longer than this are considered stale. */
export const STALE_QUESTIONS_MS = 15 * 60 * 1000;

/**
 * Cap on concepts per single generation call (spec Y/AC): a batch this size
 * keeps one provider call's payload small and cheap and its grounding
 * focused. Deterministic selection via pickGenerationConcepts.
 */
export const MAX_GENERATION_CONCEPTS = 8;

/**
 * Safety cap on concept batches run per claimed document per worker pass
 * (spec Y: bounded, never unbounded generation). Combined with
 * MAX_GENERATION_CONCEPTS this bounds the concept pool a single claim can
 * ever draw from to MAX_GENERATION_CONCEPTS * MAX_GENERATION_BATCHES_PER_DOCUMENT.
 */
export const MAX_GENERATION_BATCHES_PER_DOCUMENT = 12;

/**
 * Stop issuing further batches once at least this many questions have been
 * inserted for the document (close to "100 high-yield questions" per course
 * once a document is fully covered by its concept pool - the explicit target
 * this multi-batch loop exists to hit, spec Y/AD).
 */
export const TARGET_QUESTIONS_PER_DOCUMENT = 100;

/**
 * Circuit breaker: stop after this many consecutive batches insert zero
 * questions (e.g. thin material, or a run of concepts validation keeps
 * rejecting) rather than burning the whole batch cap on unproductive calls.
 */
export const MAX_CONSECUTIVE_EMPTY_BATCHES = 3;

/** Split `items` into consecutive chunks of at most `size` each. */
function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/**
 * Scope a batch's chunks to only those concept_sources actually links to its
 * concepts, so one call's grounding stays focused on what it was asked to
 * cover instead of the whole document (spec G). Concepts with no recorded
 * link fall back to the full chunk set for the batch — evidence scoping is a
 * focus improvement, never a reason to generate ungrounded.
 */
function scopeChunksToConcepts(
  batchConcepts: readonly GenerationConcept[],
  allChunks: readonly GenerationChunk[],
  chunksByConcept: Record<string, string[]>
): GenerationChunk[] {
  const wantedChunkIds = new Set<string>();
  let anyConceptLinked = false;
  for (const concept of batchConcepts) {
    const linkedIds = chunksByConcept[concept.key];
    if (linkedIds && linkedIds.length > 0) {
      anyConceptLinked = true;
      for (const id of linkedIds) {
        wantedChunkIds.add(id);
      }
    }
  }
  if (!anyConceptLinked) {
    return [...allChunks];
  }
  const scoped = allChunks.filter((chunk) => wantedChunkIds.has(chunk.id));
  return scoped.length > 0 ? scoped : [...allChunks];
}

/**
 * Claim and fully process one document: inputs -> fingerprint gate -> one or
 * more concept-batch rounds of (scoped provider generation -> clinical
 * validation pipeline -> atomic RPC persistence) -> ready. Never throws for
 * per-document problems; failures are recorded on the row (question
 * lifecycle only) so the queue keeps draining.
 */
export async function generateNextDocument(
  client: QuestionsClient,
  provider: QuestionGenerationProvider
): Promise<QuestionsOutcome> {
  const doc = await client.claimGenerableDocument();
  if (!doc) {
    return { status: 'idle' };
  }
  try {
    const { concepts, chunks, chunksByConcept } = await client.loadGenerationInputs(doc.id);
    // Rank the full concept pool once; batches are consecutive slices of it
    // so higher-emphasis concepts are always covered first (spec AA/Y).
    const ranked = pickGenerationConcepts(
      concepts,
      MAX_GENERATION_CONCEPTS * MAX_GENERATION_BATCHES_PER_DOCUMENT
    );
    const metadata = provider.metadata();
    const fingerprint = computeQuestionFingerprint(
      ranked.map((concept) => concept.key),
      chunks,
      metadata
    );
    if (doc.questionFingerprint === fingerprint) {
      // Nothing changed since the last successful generation (spec Y/AD): the
      // stored questions are still valid, so skip the provider entirely.
      await client.markQuestionsReady(doc.id, fingerprint);
      return { status: 'skipped', documentId: doc.id };
    }

    let inserted = 0;
    let duplicates = 0;
    let rejected = 0;
    let flagged = 0;
    let links = 0;
    let batchesRun = 0;
    let consecutiveEmptyBatches = 0;

    for (const batchConcepts of chunkArray(ranked, MAX_GENERATION_CONCEPTS)) {
      if (batchesRun >= MAX_GENERATION_BATCHES_PER_DOCUMENT) break;
      if (inserted >= TARGET_QUESTIONS_PER_DOCUMENT) break;
      if (consecutiveEmptyBatches >= MAX_CONSECUTIVE_EMPTY_BATCHES) break;

      const scopedChunks = scopeChunksToConcepts(batchConcepts, chunks, chunksByConcept);
      const generation = await provider.generate(batchConcepts, scopedChunks);
      // Generation is untrusted (spec L): every question passes the clinical
      // validation pipeline BEFORE persistence. Rejections never reach the
      // database; flagged questions land excluded from study (spec S).
      const validated = validateGenerationBatch(generation.questions);
      const result = await client.applyGeneration(
        doc.id,
        toQuestionRpcPayload(validated.accepted, scopedChunks, metadata)
      );
      batchesRun += 1;
      inserted += result.inserted;
      duplicates += result.skipped + validated.duplicatesRemoved;
      rejected += validated.rejected.length;
      flagged += validated.accepted.filter((question) => question.status === 'flagged').length;
      links += result.links;
      consecutiveEmptyBatches = result.inserted === 0 ? consecutiveEmptyBatches + 1 : 0;
    }

    await client.markQuestionsReady(doc.id, fingerprint);
    return {
      status: 'generated',
      documentId: doc.id,
      inserted,
      duplicates,
      rejected,
      flagged,
      links,
      batches: batchesRun,
    };
  } catch (error) {
    const detail = errorMessage(error);
    try {
      await client.markQuestionsFailed(doc.id, detail.slice(0, 2000));
    } catch {
      // Even the failure write failed; the row stays 'generating' and will be
      // reset to 'pending' by recoverStaleQuestions.
    }
    return { status: 'failed', documentId: doc.id };
  }
}

/** Generate until nothing is pending; returns the outcomes in order. */
export async function drainQuestionQueue(
  client: QuestionsClient,
  provider: QuestionGenerationProvider
): Promise<QuestionsOutcome[]> {
  const outcomes: QuestionsOutcome[] = [];
  for (;;) {
    const outcome = await generateNextDocument(client, provider);
    if (outcome.status === 'idle') {
      return outcomes;
    }
    outcomes.push(outcome);
  }
}
