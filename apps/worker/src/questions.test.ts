import {
  computeQuestionFingerprint,
  EVAL_GENERATION_CHUNKS,
  EVAL_GENERATION_CONCEPTS,
  GenerationChunk,
  GenerationConcept,
  pickGenerationConcepts,
  QuestionGenerationProvider,
  QuestionGenerationRpcPayload,
  RawGeneratedQuestion,
  ScriptedQuestionGenerationProvider,
} from '@avidia/assessment';

import {
  drainQuestionQueue,
  GenerableDocument,
  generateNextDocument,
  MAX_CONSECUTIVE_EMPTY_BATCHES,
  MAX_GENERATION_BATCHES_PER_DOCUMENT,
  MAX_GENERATION_CONCEPTS,
  QuestionsClient,
  TARGET_QUESTIONS_PER_DOCUMENT,
} from './questions';

type DocumentInputs = {
  concepts: GenerationConcept[];
  chunks: GenerationChunk[];
  chunksByConcept: Record<string, string[]>;
};

/** In-memory QuestionsClient double mirroring the fake knowledge client. */
class FakeQuestionsClient implements QuestionsClient {
  queue: GenerableDocument[] = [];
  inputsByDocument = new Map<string, DocumentInputs>();
  applied: { documentId: string; payload: QuestionGenerationRpcPayload }[] = [];
  ready: { documentId: string; fingerprint: string }[] = [];
  failed: { documentId: string; detail: string }[] = [];
  failApply = false;
  failMarkFailed = false;

  claimGenerableDocument(): Promise<GenerableDocument | null> {
    return Promise.resolve(this.queue.shift() ?? null);
  }

  loadGenerationInputs(documentId: string) {
    return Promise.resolve(
      this.inputsByDocument.get(documentId) ?? { concepts: [], chunks: [], chunksByConcept: {} }
    );
  }

  applyGeneration(documentId: string, payload: QuestionGenerationRpcPayload) {
    if (this.failApply) {
      return Promise.reject(new Error('rpc unavailable'));
    }
    this.applied.push({ documentId, payload });
    return Promise.resolve({
      inserted: payload.questions.length,
      skipped: 0,
      links: payload.questions.reduce((sum, question) => sum + question.chunk_ids.length, 0),
      retired: 0,
    });
  }

  markQuestionsReady(documentId: string, fingerprint: string): Promise<void> {
    this.ready.push({ documentId, fingerprint });
    return Promise.resolve();
  }

  markQuestionsFailed(documentId: string, detail: string): Promise<void> {
    if (this.failMarkFailed) {
      return Promise.reject(new Error('database down'));
    }
    this.failed.push({ documentId, detail });
    return Promise.resolve();
  }

  recoverStaleQuestions(): Promise<number> {
    return Promise.resolve(0);
  }
}

const scripted = new ScriptedQuestionGenerationProvider();

function seed(client: FakeQuestionsClient, id: string, fingerprint: string | null = null): void {
  client.queue.push({ id, questionFingerprint: fingerprint });
  client.inputsByDocument.set(id, {
    concepts: [...EVAL_GENERATION_CONCEPTS],
    chunks: [...EVAL_GENERATION_CHUNKS],
    chunksByConcept: {},
  });
}

function expectedFingerprint(): string {
  const selected = pickGenerationConcepts(
    EVAL_GENERATION_CONCEPTS,
    MAX_GENERATION_CONCEPTS * MAX_GENERATION_BATCHES_PER_DOCUMENT
  );
  return computeQuestionFingerprint(
    selected.map((concept) => concept.key),
    EVAL_GENERATION_CHUNKS,
    scripted.metadata()
  );
}

/** A synthetic pool of concepts spanning several MAX_GENERATION_CONCEPTS-sized batches. */
function makeConcepts(count: number): GenerationConcept[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `concept-${index}`,
    name: `Concept ${index}`,
    type: 'disease_disorder',
    // Descending emphasis so batch order (highest emphasis first) is deterministic.
    emphasisScore: count - index,
  }));
}

/** One structurally- and clinically-valid question, unique by (conceptKey, seed). */
function makeValidQuestion(conceptKey: string, seed: number): RawGeneratedQuestion {
  return {
    question_type: 'single_best_answer',
    stem:
      `A client scenario ${seed} involving ${conceptKey} requires the nurse to select the ` +
      `priority action based on the assessment findings described in the material above.`,
    difficulty: 'moderate',
    cognitive_level: 'application',
    concept_key: conceptKey,
    priority_frameworks: [],
    rationale:
      `Addressing the priority finding first for ${conceptKey} case ${seed} protects the ` +
      `client before any secondary intervention is considered.`,
    options: [
      {
        text: `Take the priority action for ${conceptKey} case ${seed}`,
        is_correct: true,
        correct_position: null,
        rationale: 'This directly addresses the priority concern.',
      },
      {
        text: `Take a secondary action for ${conceptKey} case ${seed}`,
        is_correct: false,
        correct_position: null,
        rationale: 'Appropriate later, but not the priority right now.',
      },
      {
        text: `Take an unrelated action for ${conceptKey} case ${seed}`,
        is_correct: false,
        correct_position: null,
        rationale: 'Does not address the assessment finding.',
      },
      {
        text: `Delay and reassess later for ${conceptKey} case ${seed}`,
        is_correct: false,
        correct_position: null,
        rationale: "Delaying risks the client's safety.",
      },
    ],
    expected_value: null,
    tolerance: null,
    answer_unit: null,
    rounding_note: null,
    chunk_indexes: [],
  };
}

describe('generateNextDocument', () => {
  it('is idle when nothing is claimable', async () => {
    const client = new FakeQuestionsClient();
    await expect(generateNextDocument(client, scripted)).resolves.toEqual({ status: 'idle' });
  });

  it('generates, validates, persists via the RPC payload, and marks ready with a fingerprint', async () => {
    const client = new FakeQuestionsClient();
    seed(client, 'doc-1');
    const outcome = await generateNextDocument(client, scripted);
    expect(outcome.status).toBe('generated');
    if (outcome.status === 'generated') {
      expect(outcome.inserted).toBeGreaterThan(0);
      expect(outcome.rejected).toBe(0);
      // EVAL_GENERATION_CONCEPTS (6) fits in a single MAX_GENERATION_CONCEPTS batch.
      expect(outcome.batches).toBe(1);
    }
    expect(client.applied).toHaveLength(1);
    const { documentId, payload } = client.applied[0]!;
    expect(documentId).toBe('doc-1');
    expect(payload.generation).toEqual({
      provider: 'scripted',
      model: 'scripted-templates',
      prompt_version: 'p2',
      generation_version: 'v2',
    });
    // Every question is validated: status only ever generated/flagged, never
    // active straight out of generation (spec J/S; review gate ADR-0018 §4).
    for (const question of payload.questions) {
      expect(['generated', 'flagged']).toContain(question.status);
      expect(question.content_hash).toMatch(/^[0-9a-f]{64}$/);
      // Provenance maps chunk indexes back to real source_chunks ids (spec Q).
      for (const chunkId of question.chunk_ids) {
        expect(EVAL_GENERATION_CHUNKS.map((chunk) => chunk.id)).toContain(chunkId);
      }
    }
    expect(client.ready).toHaveLength(1);
    expect(client.ready[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(client.failed).toHaveLength(0);
  });

  it('skips the AI provider entirely when the fingerprint is unchanged (spec Y/AD)', async () => {
    const client = new FakeQuestionsClient();
    const fingerprint = expectedFingerprint();
    seed(client, 'doc-1', fingerprint);
    const generate = jest.fn();
    const provider: QuestionGenerationProvider = {
      generate,
      metadata: () => scripted.metadata(),
    };
    const outcome = await generateNextDocument(client, provider);
    expect(outcome).toEqual({ status: 'skipped', documentId: 'doc-1' });
    expect(generate).not.toHaveBeenCalled();
    expect(client.applied).toHaveLength(0);
    expect(client.ready).toEqual([{ documentId: 'doc-1', fingerprint }]);
  });

  it('re-generates when the stored fingerprint no longer matches', async () => {
    const client = new FakeQuestionsClient();
    seed(client, 'doc-1', 'stale-fingerprint');
    const outcome = await generateNextDocument(client, scripted);
    expect(outcome.status).toBe('generated');
    expect(client.applied).toHaveLength(1);
  });

  it('invalid provider output is filtered out, never persisted (spec J/K)', async () => {
    const client = new FakeQuestionsClient();
    seed(client, 'doc-1');
    const provider: QuestionGenerationProvider = {
      generate: async (concepts, chunks) => {
        const good = await scripted.generate(concepts, chunks);
        return {
          questions: [
            ...good.questions,
            {
              // Two-correct single_best_answer: a hard rejection.
              ...good.questions[0]!,
              stem: 'A different stem long enough to pass structural checks easily.',
              options: good.questions[0]!.options.map((option) => ({
                ...option,
                is_correct: true,
              })),
            },
          ],
        };
      },
      metadata: () => scripted.metadata(),
    };
    const outcome = await generateNextDocument(client, provider);
    expect(outcome.status).toBe('generated');
    if (outcome.status === 'generated') {
      expect(outcome.rejected).toBe(1);
    }
    // The rejected question never reached the RPC payload.
    const persisted = client.applied[0]!.payload.questions;
    expect(persisted.every((question) => ['generated', 'flagged'].includes(question.status))).toBe(
      true
    );
  });

  it('marks only the question lifecycle failed when the provider throws (spec AE)', async () => {
    const client = new FakeQuestionsClient();
    seed(client, 'doc-1');
    const provider: QuestionGenerationProvider = {
      generate: () => Promise.reject(new Error('rate limited after retries')),
      metadata: () => scripted.metadata(),
    };
    const outcome = await generateNextDocument(client, provider);
    expect(outcome).toEqual({ status: 'failed', documentId: 'doc-1' });
    expect(client.failed).toEqual([{ documentId: 'doc-1', detail: 'rate limited after retries' }]);
    expect(client.ready).toHaveLength(0);
    expect(client.applied).toHaveLength(0);
  });

  it('records a failure when the RPC persistence fails', async () => {
    const client = new FakeQuestionsClient();
    seed(client, 'doc-1');
    client.failApply = true;
    const outcome = await generateNextDocument(client, scripted);
    expect(outcome.status).toBe('failed');
    expect(client.failed[0]!.detail).toBe('rpc unavailable');
    expect(client.ready).toHaveLength(0);
  });

  it('never throws even when the failure write itself fails (stale sweep recovers)', async () => {
    const client = new FakeQuestionsClient();
    seed(client, 'doc-1');
    client.failApply = true;
    client.failMarkFailed = true;
    await expect(generateNextDocument(client, scripted)).resolves.toEqual({
      status: 'failed',
      documentId: 'doc-1',
    });
  });

  it('handles a document with no concepts or chunks without calling the provider or the RPC', async () => {
    const client = new FakeQuestionsClient();
    client.queue.push({ id: 'doc-1', questionFingerprint: null });
    client.inputsByDocument.set('doc-1', { concepts: [], chunks: [], chunksByConcept: {} });
    const generate = jest.fn();
    const provider: QuestionGenerationProvider = { generate, metadata: () => scripted.metadata() };
    const outcome = await generateNextDocument(client, provider);
    expect(outcome).toEqual({
      status: 'generated',
      documentId: 'doc-1',
      inserted: 0,
      duplicates: 0,
      rejected: 0,
      flagged: 0,
      links: 0,
      batches: 0,
    });
    expect(generate).not.toHaveBeenCalled();
    expect(client.applied).toHaveLength(0);
    expect(client.ready).toHaveLength(1);
  });

  it('runs multiple concept batches when the document has more concepts than one batch holds', async () => {
    const client = new FakeQuestionsClient();
    const concepts = makeConcepts(20); // 20 concepts / 8 per batch = 3 batches
    client.queue.push({ id: 'doc-1', questionFingerprint: null });
    client.inputsByDocument.set('doc-1', { concepts, chunks: [], chunksByConcept: {} });

    const seenConceptKeys: string[] = [];
    let callIndex = 0;
    const provider: QuestionGenerationProvider = {
      generate: (batchConcepts) => {
        callIndex += 1;
        seenConceptKeys.push(...batchConcepts.map((concept) => concept.key));
        return Promise.resolve({
          questions: batchConcepts.map((concept) => makeValidQuestion(concept.key, callIndex)),
        });
      },
      metadata: () => scripted.metadata(),
    };

    const outcome = await generateNextDocument(client, provider);
    expect(outcome.status).toBe('generated');
    if (outcome.status === 'generated') {
      expect(outcome.batches).toBe(3);
      expect(outcome.inserted).toBe(20);
    }
    expect(client.applied).toHaveLength(3);
    expect(client.applied.map((entry) => entry.payload.questions.length)).toEqual([8, 8, 4]);
    // Every concept was covered exactly once, across the 3 calls.
    expect(seenConceptKeys.sort()).toEqual(concepts.map((concept) => concept.key).sort());
    expect(client.ready).toHaveLength(1);
  });

  it('stops issuing batches once TARGET_QUESTIONS_PER_DOCUMENT is reached', async () => {
    const client = new FakeQuestionsClient();
    // Enough concept batches available that the target, not the concept
    // pool, is what ends the run.
    const concepts = makeConcepts(MAX_GENERATION_CONCEPTS * MAX_GENERATION_BATCHES_PER_DOCUMENT);
    client.queue.push({ id: 'doc-1', questionFingerprint: null });
    client.inputsByDocument.set('doc-1', { concepts, chunks: [], chunksByConcept: {} });

    // Each batch inserts more than a third of the target (independent of how
    // many concepts landed in the batch), so the target is reached in fewer
    // batches than the safety cap would otherwise allow.
    const perBatch = Math.ceil(TARGET_QUESTIONS_PER_DOCUMENT / 3);
    let callIndex = 0;
    const provider: QuestionGenerationProvider = {
      generate: (batchConcepts) => {
        callIndex += 1;
        const key = batchConcepts[0]!.key;
        return Promise.resolve({
          questions: Array.from({ length: perBatch }, (_, index) =>
            makeValidQuestion(key, callIndex * 1000 + index)
          ),
        });
      },
      metadata: () => scripted.metadata(),
    };

    const outcome = await generateNextDocument(client, provider);
    expect(outcome.status).toBe('generated');
    if (outcome.status === 'generated') {
      expect(outcome.inserted).toBeGreaterThanOrEqual(TARGET_QUESTIONS_PER_DOCUMENT);
      expect(outcome.batches).toBeLessThan(MAX_GENERATION_BATCHES_PER_DOCUMENT);
    }
  });

  it('trips the circuit breaker after consecutive empty batches', async () => {
    const client = new FakeQuestionsClient();
    const concepts = makeConcepts(MAX_GENERATION_CONCEPTS * MAX_GENERATION_BATCHES_PER_DOCUMENT);
    client.queue.push({ id: 'doc-1', questionFingerprint: null });
    client.inputsByDocument.set('doc-1', { concepts, chunks: [], chunksByConcept: {} });
    const provider: QuestionGenerationProvider = {
      generate: () => Promise.resolve({ questions: [] }), // every batch yields nothing
      metadata: () => scripted.metadata(),
    };

    const outcome = await generateNextDocument(client, provider);
    expect(outcome.status).toBe('generated');
    if (outcome.status === 'generated') {
      expect(outcome.inserted).toBe(0);
      expect(outcome.batches).toBe(MAX_CONSECUTIVE_EMPTY_BATCHES);
    }
    expect(client.applied).toHaveLength(MAX_CONSECUTIVE_EMPTY_BATCHES);
    expect(client.ready).toHaveLength(1);
  });

  it('never runs more than MAX_GENERATION_BATCHES_PER_DOCUMENT batches', async () => {
    const client = new FakeQuestionsClient();
    const concepts = makeConcepts(
      MAX_GENERATION_CONCEPTS * (MAX_GENERATION_BATCHES_PER_DOCUMENT + 5)
    );
    client.queue.push({ id: 'doc-1', questionFingerprint: null });
    client.inputsByDocument.set('doc-1', { concepts, chunks: [], chunksByConcept: {} });
    let callIndex = 0;
    const provider: QuestionGenerationProvider = {
      // One question per batch: never hits the target, never trips the
      // empty-batch breaker, so only the hard batch cap can stop it.
      generate: (batchConcepts) => {
        callIndex += 1;
        return Promise.resolve({
          questions: [makeValidQuestion(batchConcepts[0]!.key, callIndex)],
        });
      },
      metadata: () => scripted.metadata(),
    };

    const outcome = await generateNextDocument(client, provider);
    expect(outcome.status).toBe('generated');
    if (outcome.status === 'generated') {
      expect(outcome.batches).toBe(MAX_GENERATION_BATCHES_PER_DOCUMENT);
    }
  });

  it('scopes each batch to only the chunks concept_sources links to its concepts', async () => {
    const client = new FakeQuestionsClient();
    const concepts = makeConcepts(2);
    const chunks: GenerationChunk[] = [
      { id: 'chunk-a', content: 'evidence for concept-0', locator: 'p1' },
      { id: 'chunk-b', content: 'evidence for concept-1', locator: 'p2' },
      { id: 'chunk-c', content: 'unrelated evidence', locator: 'p3' },
    ];
    client.queue.push({ id: 'doc-1', questionFingerprint: null });
    client.inputsByDocument.set('doc-1', {
      concepts,
      chunks,
      chunksByConcept: { 'concept-0': ['chunk-a'], 'concept-1': ['chunk-b'] },
    });
    const seenChunkIds: string[] = [];
    const provider: QuestionGenerationProvider = {
      generate: (batchConcepts, batchChunks) => {
        seenChunkIds.push(...batchChunks.map((chunk) => chunk.id));
        return Promise.resolve({ questions: [] });
      },
      metadata: () => scripted.metadata(),
    };

    await generateNextDocument(client, provider);
    // Both concepts land in one batch (2 <= MAX_GENERATION_CONCEPTS); only
    // their linked chunks should be sent, not the unrelated third chunk.
    expect(seenChunkIds.sort()).toEqual(['chunk-a', 'chunk-b']);
  });

  it('falls back to the full chunk set for a batch whose concepts have no recorded links', async () => {
    const client = new FakeQuestionsClient();
    const concepts = makeConcepts(1);
    const chunks: GenerationChunk[] = [
      { id: 'chunk-a', content: 'a', locator: 'p1' },
      { id: 'chunk-b', content: 'b', locator: 'p2' },
    ];
    client.queue.push({ id: 'doc-1', questionFingerprint: null });
    client.inputsByDocument.set('doc-1', { concepts, chunks, chunksByConcept: {} });
    const seenChunkIds: string[] = [];
    const provider: QuestionGenerationProvider = {
      generate: (batchConcepts, batchChunks) => {
        seenChunkIds.push(...batchChunks.map((chunk) => chunk.id));
        return Promise.resolve({ questions: [] });
      },
      metadata: () => scripted.metadata(),
    };

    await generateNextDocument(client, provider);
    expect(seenChunkIds.sort()).toEqual(['chunk-a', 'chunk-b']);
  });
});

describe('drainQuestionQueue', () => {
  it('drains until idle, isolating failures per document', async () => {
    const client = new FakeQuestionsClient();
    seed(client, 'doc-1');
    client.queue.push({ id: 'doc-2', questionFingerprint: null }); // no inputs: empty batch
    seed(client, 'doc-3');
    const outcomes = await drainQuestionQueue(client, scripted);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'generated',
      'generated',
      'generated',
    ]);
    expect(client.ready).toHaveLength(3);
  });

  it('is idempotent across re-runs: a second drain skips on fingerprints', async () => {
    const client = new FakeQuestionsClient();
    seed(client, 'doc-1');
    const first = await drainQuestionQueue(client, scripted);
    expect(first[0]!.status).toBe('generated');
    const storedFingerprint = client.ready[0]!.fingerprint;
    // Retry of the same unchanged document (e.g. after a crash before commit).
    client.queue.push({ id: 'doc-1', questionFingerprint: storedFingerprint });
    client.inputsByDocument.set('doc-1', {
      concepts: [...EVAL_GENERATION_CONCEPTS],
      chunks: [...EVAL_GENERATION_CHUNKS],
      chunksByConcept: {},
    });
    const second = await drainQuestionQueue(client, scripted);
    expect(second).toEqual([{ status: 'skipped', documentId: 'doc-1' }]);
    // No second RPC write — no duplicate questions on retry (spec R/Y).
    expect(client.applied).toHaveLength(1);
  });
});
