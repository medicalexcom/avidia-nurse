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

/**
 * Question-generation stage (M7 spec G/I/Y/AD/AE).
 *
 * The FOURTH independent document lifecycle, tracked in
 * documents.question_status (pending → generating → ready | failed),
 * alongside M4 processing_status, M5 index_status and M6 knowledge_status. A
 * document becomes generable only once knowledge_status='ready': questions
 * are grounded in the same source_chunks retrieval uses and target the M6
 * concepts, so provenance lines up across milestones. Re-extraction resets
 * question_status to 'pending' — questions always derive from the current
 * concept evidence, never stale knowledge.
 *
 * Failure isolation (spec AE): a generation failure marks ONLY
 * question_status='failed'; reading, retrieval and the knowledge map stay
 * fully usable, and the stage is retryable. Studying never requires a live
 * LLM — sessions draw from already-persisted questions.
 *
 * Cost control (spec Y/AD): a SHA-256 fingerprint over provider/model/prompt
 * version/generation version plus the selected concept keys and the exact
 * chunk ids and contents is compared with the stored fingerprint before any
 * AI call. Unchanged material never pays for generation again.
 */

/** Minimal projection of a documents row the questions stage needs. */
export interface GenerableDocument {
  id: string;
  /** documents.question_fingerprint from the previous successful run. */
  questionFingerprint: string | null;
}

/** What generation is grounded in: the document's concepts and chunks. */
export interface GenerationInputs {
  concepts: GenerationConcept[];
  chunks: GenerationChunk[];
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
   * content hash, retire evidence-less course-grounded questions — one
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
    }
  | { status: 'failed'; documentId: string };

/** Documents stuck in 'generating' longer than this are considered stale. */
export const STALE_QUESTIONS_MS = 15 * 60 * 1000;

/**
 * Cap on concepts per generation call (spec Y/AC): the highest-emphasis
 * concepts are enough for a useful first question set, and the payload stays
 * small and cheap. Deterministic selection via pickGenerationConcepts.
 */
export const MAX_GENERATION_CONCEPTS = 8;

/**
 * Claim and fully process one document: inputs → fingerprint gate → provider
 * generation → clinical validation pipeline → atomic RPC persistence. Never
 * throws for per-document problems; failures are recorded on the row
 * (question lifecycle only) so the queue keeps draining.
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
    const { concepts, chunks } = await client.loadGenerationInputs(doc.id);
    const selected = pickGenerationConcepts(concepts, MAX_GENERATION_CONCEPTS);
    const metadata = provider.metadata();
    const fingerprint = computeQuestionFingerprint(
      selected.map((concept) => concept.key),
      chunks,
      metadata
    );
    if (doc.questionFingerprint === fingerprint) {
      // Nothing changed since the last successful generation (spec Y/AD): the
      // stored questions are still valid, so skip the provider entirely.
      await client.markQuestionsReady(doc.id, fingerprint);
      return { status: 'skipped', documentId: doc.id };
    }

    const generation = await provider.generate(selected, chunks);
    // Generation is untrusted (spec L): every question passes the clinical
    // validation pipeline BEFORE persistence. Rejections never reach the
    // database; flagged questions land excluded from study (spec S).
    const batch = validateGenerationBatch(generation.questions);
    const result = await client.applyGeneration(
      doc.id,
      toQuestionRpcPayload(batch.accepted, chunks, metadata)
    );
    await client.markQuestionsReady(doc.id, fingerprint);
    return {
      status: 'generated',
      documentId: doc.id,
      inserted: result.inserted,
      duplicates: result.skipped + batch.duplicatesRemoved,
      rejected: batch.rejected.length,
      flagged: batch.accepted.filter((question) => question.status === 'flagged').length,
      links: result.links,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
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
