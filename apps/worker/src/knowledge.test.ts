import {
  computeKnowledgeFingerprint,
  ConceptExtractionProvider,
  EVAL_EXTRACTION_CHUNKS,
  ExtractionChunk,
  ExtractionRpcPayload,
  RawExtraction,
  ScriptedConceptExtractionProvider,
} from '@avidia/knowledge';

import {
  drainKnowledgeQueue,
  ExtractableDocument,
  extractNextDocument,
  KnowledgeClient,
} from './knowledge';

/** In-memory KnowledgeClient double mirroring the fake worker/indexer clients. */
class FakeKnowledgeClient implements KnowledgeClient {
  queue: ExtractableDocument[] = [];
  chunksByDocument = new Map<string, ExtractionChunk[]>();
  applied: { documentId: string; payload: ExtractionRpcPayload }[] = [];
  ready: { documentId: string; fingerprint: string }[] = [];
  failed: { documentId: string; detail: string }[] = [];
  failApply = false;
  failMarkFailed = false;

  claimExtractableDocument(): Promise<ExtractableDocument | null> {
    return Promise.resolve(this.queue.shift() ?? null);
  }

  loadExtractionChunks(documentId: string): Promise<ExtractionChunk[]> {
    return Promise.resolve(this.chunksByDocument.get(documentId) ?? []);
  }

  applyExtraction(documentId: string, payload: ExtractionRpcPayload) {
    if (this.failApply) {
      return Promise.reject(new Error('rpc unavailable'));
    }
    this.applied.push({ documentId, payload });
    return Promise.resolve({
      newConcepts: payload.concepts.length,
      links: payload.concepts.reduce((sum, concept) => sum + concept.chunk_ids.length, 0),
      relationships: payload.relationships.length,
      pruned: 0,
    });
  }

  markKnowledgeReady(documentId: string, fingerprint: string): Promise<void> {
    this.ready.push({ documentId, fingerprint });
    return Promise.resolve();
  }

  markKnowledgeFailed(documentId: string, detail: string): Promise<void> {
    if (this.failMarkFailed) {
      return Promise.reject(new Error('database down'));
    }
    this.failed.push({ documentId, detail });
    return Promise.resolve();
  }

  recoverStaleKnowledge(): Promise<number> {
    return Promise.resolve(0);
  }
}

const scripted = new ScriptedConceptExtractionProvider();

function seed(client: FakeKnowledgeClient, id: string, fingerprint: string | null = null): void {
  client.queue.push({ id, knowledgeFingerprint: fingerprint });
  client.chunksByDocument.set(id, [...EVAL_EXTRACTION_CHUNKS]);
}

describe('extractNextDocument', () => {
  it('is idle when nothing is claimable', async () => {
    const client = new FakeKnowledgeClient();
    await expect(extractNextDocument(client, scripted)).resolves.toEqual({ status: 'idle' });
  });

  it('extracts, refines, persists via the RPC payload, and marks ready with a fingerprint', async () => {
    const client = new FakeKnowledgeClient();
    seed(client, 'doc-1');
    const outcome = await extractNextDocument(client, scripted);
    expect(outcome.status).toBe('extracted');
    expect(client.applied).toHaveLength(1);
    const { documentId, payload } = client.applied[0]!;
    expect(documentId).toBe('doc-1');
    expect(payload.extraction).toEqual({
      provider: 'scripted',
      model: 'scripted-lexicon',
      prompt_version: 'p1',
      extraction_version: 'v1',
    });
    const keys = payload.concepts.map((concept) => concept.key);
    expect(keys).toContain('diabetic ketoacidosis');
    expect(keys).toContain('furosemide');
    // Provenance maps chunk indexes back to real source_chunks ids.
    const dka = payload.concepts.find((concept) => concept.key === 'diabetic ketoacidosis')!;
    expect(dka.chunk_ids).toEqual(['chunk-dka']);
    expect(client.ready).toHaveLength(1);
    expect(client.ready[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(client.failed).toHaveLength(0);
  });

  it('skips the AI provider entirely when the fingerprint is unchanged (spec S)', async () => {
    const client = new FakeKnowledgeClient();
    const fingerprint = computeKnowledgeFingerprint(EVAL_EXTRACTION_CHUNKS, scripted.metadata());
    seed(client, 'doc-1', fingerprint);
    const extract = jest.fn();
    const provider: ConceptExtractionProvider = {
      extract,
      metadata: () => scripted.metadata(),
    };
    const outcome = await extractNextDocument(client, provider);
    expect(outcome).toEqual({ status: 'skipped', documentId: 'doc-1' });
    expect(extract).not.toHaveBeenCalled();
    expect(client.applied).toHaveLength(0);
    expect(client.ready).toEqual([{ documentId: 'doc-1', fingerprint }]);
  });

  it('re-extracts when the stored fingerprint no longer matches', async () => {
    const client = new FakeKnowledgeClient();
    seed(client, 'doc-1', 'stale-fingerprint');
    const outcome = await extractNextDocument(client, scripted);
    expect(outcome.status).toBe('extracted');
    expect(client.applied).toHaveLength(1);
  });

  it('re-bases batch-local chunk indexes across multiple batches', async () => {
    const client = new FakeKnowledgeClient();
    // Two fat chunks that cannot share a batch under the token budget.
    const chunks: ExtractionChunk[] = [
      { id: 'chunk-a', locator: 'slide 1', content: `Hyperkalemia. ${'x'.repeat(23000)}` },
      { id: 'chunk-b', locator: 'slide 2', content: `Hypokalemia. ${'y'.repeat(23000)}` },
    ];
    client.queue.push({ id: 'doc-1', knowledgeFingerprint: null });
    client.chunksByDocument.set('doc-1', chunks);
    const provider: ConceptExtractionProvider = {
      extract: (batch): Promise<RawExtraction> =>
        Promise.resolve({
          // Every batch cites ITS OWN index 0 — the orchestrator must re-base.
          concepts: batch[0]!.content.startsWith('Hyperkalemia')
            ? [{ name: 'Hyperkalemia', type: 'laboratory', aliases: [], chunk_indexes: [0] }]
            : [{ name: 'Hypokalemia', type: 'laboratory', aliases: [], chunk_indexes: [0] }],
          relationships: [],
        }),
      metadata: () => scripted.metadata(),
    };
    const outcome = await extractNextDocument(client, provider);
    expect(outcome.status).toBe('extracted');
    const payload = client.applied[0]!.payload;
    const hyper = payload.concepts.find((concept) => concept.key === 'hyperkalemia')!;
    const hypo = payload.concepts.find((concept) => concept.key === 'hypokalemia')!;
    expect(hyper.chunk_ids).toEqual(['chunk-a']);
    expect(hypo.chunk_ids).toEqual(['chunk-b']);
  });

  it('marks only the knowledge lifecycle failed when the provider throws (spec T)', async () => {
    const client = new FakeKnowledgeClient();
    seed(client, 'doc-1');
    const provider: ConceptExtractionProvider = {
      extract: () => Promise.reject(new Error('rate limited after retries')),
      metadata: () => scripted.metadata(),
    };
    const outcome = await extractNextDocument(client, provider);
    expect(outcome).toEqual({ status: 'failed', documentId: 'doc-1' });
    expect(client.failed).toEqual([{ documentId: 'doc-1', detail: 'rate limited after retries' }]);
    expect(client.ready).toHaveLength(0);
    expect(client.applied).toHaveLength(0);
  });

  it('records a failure when the RPC persistence fails', async () => {
    const client = new FakeKnowledgeClient();
    seed(client, 'doc-1');
    client.failApply = true;
    const outcome = await extractNextDocument(client, scripted);
    expect(outcome.status).toBe('failed');
    expect(client.failed[0]!.detail).toBe('rpc unavailable');
    expect(client.ready).toHaveLength(0);
  });

  it('never throws even when the failure write itself fails (stale sweep recovers)', async () => {
    const client = new FakeKnowledgeClient();
    seed(client, 'doc-1');
    client.failApply = true;
    client.failMarkFailed = true;
    await expect(extractNextDocument(client, scripted)).resolves.toEqual({
      status: 'failed',
      documentId: 'doc-1',
    });
  });

  it('handles an empty-chunk document without calling the provider pointlessly', async () => {
    const client = new FakeKnowledgeClient();
    client.queue.push({ id: 'doc-1', knowledgeFingerprint: null });
    client.chunksByDocument.set('doc-1', []);
    const outcome = await extractNextDocument(client, scripted);
    expect(outcome.status).toBe('extracted');
    expect(client.applied[0]!.payload.concepts).toEqual([]);
    expect(client.ready).toHaveLength(1);
  });
});

describe('drainKnowledgeQueue', () => {
  it('drains until idle, isolating failures per document', async () => {
    const client = new FakeKnowledgeClient();
    seed(client, 'doc-1');
    client.queue.push({ id: 'doc-2', knowledgeFingerprint: null }); // no chunks: empty extraction
    seed(client, 'doc-3');
    const outcomes = await drainKnowledgeQueue(client, scripted);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'extracted',
      'extracted',
      'extracted',
    ]);
    expect(client.ready).toHaveLength(3);
  });

  it('is idempotent across re-runs: a second drain skips on fingerprints', async () => {
    const client = new FakeKnowledgeClient();
    seed(client, 'doc-1');
    const first = await drainKnowledgeQueue(client, scripted);
    expect(first[0]!.status).toBe('extracted');
    const storedFingerprint = client.ready[0]!.fingerprint;
    // Retry of the same unchanged document (e.g. after a crash before commit).
    client.queue.push({ id: 'doc-1', knowledgeFingerprint: storedFingerprint });
    const second = await drainKnowledgeQueue(client, scripted);
    expect(second).toEqual([{ status: 'skipped', documentId: 'doc-1' }]);
    // No second RPC write — no duplicate concepts on retry (spec N).
    expect(client.applied).toHaveLength(1);
  });
});
