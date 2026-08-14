import {
  computeQuestionFingerprint,
  EVAL_GENERATION_CHUNKS,
  EVAL_GENERATION_CONCEPTS,
  GenerationChunk,
  GenerationConcept,
  pickGenerationConcepts,
  QuestionGenerationProvider,
  QuestionGenerationRpcPayload,
  ScriptedQuestionGenerationProvider,
} from '@avidia/assessment';

import {
  drainQuestionQueue,
  GenerableDocument,
  generateNextDocument,
  MAX_GENERATION_CONCEPTS,
  QuestionsClient,
} from './questions';

/** In-memory QuestionsClient double mirroring the fake knowledge client. */
class FakeQuestionsClient implements QuestionsClient {
  queue: GenerableDocument[] = [];
  inputsByDocument = new Map<
    string,
    { concepts: GenerationConcept[]; chunks: GenerationChunk[] }
  >();
  applied: { documentId: string; payload: QuestionGenerationRpcPayload }[] = [];
  ready: { documentId: string; fingerprint: string }[] = [];
  failed: { documentId: string; detail: string }[] = [];
  failApply = false;
  failMarkFailed = false;

  claimGenerableDocument(): Promise<GenerableDocument | null> {
    return Promise.resolve(this.queue.shift() ?? null);
  }

  loadGenerationInputs(documentId: string) {
    return Promise.resolve(this.inputsByDocument.get(documentId) ?? { concepts: [], chunks: [] });
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
  });
}

function expectedFingerprint(): string {
  const selected = pickGenerationConcepts(EVAL_GENERATION_CONCEPTS, MAX_GENERATION_CONCEPTS);
  return computeQuestionFingerprint(
    selected.map((concept) => concept.key),
    EVAL_GENERATION_CHUNKS,
    scripted.metadata()
  );
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
    }
    expect(client.applied).toHaveLength(1);
    const { documentId, payload } = client.applied[0]!;
    expect(documentId).toBe('doc-1');
    expect(payload.generation).toEqual({
      provider: 'scripted',
      model: 'scripted-templates',
      prompt_version: 'p1',
      generation_version: 'v1',
    });
    // Every question is validated: status only ever active/flagged (spec J/S).
    for (const question of payload.questions) {
      expect(['active', 'flagged']).toContain(question.status);
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
    expect(persisted.every((question) => ['active', 'flagged'].includes(question.status))).toBe(
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

  it('handles a document with no concepts or chunks without a pointless AI call', async () => {
    const client = new FakeQuestionsClient();
    client.queue.push({ id: 'doc-1', questionFingerprint: null });
    client.inputsByDocument.set('doc-1', { concepts: [], chunks: [] });
    const outcome = await generateNextDocument(client, scripted);
    expect(outcome.status).toBe('generated');
    expect(client.applied[0]!.payload.questions).toEqual([]);
    expect(client.ready).toHaveLength(1);
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
    });
    const second = await drainQuestionQueue(client, scripted);
    expect(second).toEqual([{ status: 'skipped', documentId: 'doc-1' }]);
    // No second RPC write — no duplicate questions on retry (spec R/Y).
    expect(client.applied).toHaveLength(1);
  });
});
