import { ExtractedSection, MaterialExtension } from '@avidia/domain';
import { HashingEmbeddingProvider, RagChunk } from '@avidia/rag';

import { drainIndexQueue, IndexableDocument, IndexerClient, indexNextDocument } from './indexer';

function section(overrides: Partial<ExtractedSection>): ExtractedSection {
  return {
    sectionType: 'paragraph',
    sequence: 0,
    pageNumber: null,
    slideNumber: null,
    heading: null,
    content: 'content',
    metadata: null,
    ...overrides,
  };
}

interface FakeDoc {
  id: string;
  fileExtension: MaterialExtension;
  indexStatus: 'pending' | 'indexing' | 'indexed' | 'failed';
  indexAttempts: number;
  indexDetail: string | null;
  sections: ExtractedSection[];
}

class FakeIndexerClient implements IndexerClient {
  stored = new Map<string, { chunks: RagChunk[]; embeddings: number[][] }>();
  failReplace = false;

  constructor(readonly docs: FakeDoc[]) {}

  claimIndexableDocument(): Promise<IndexableDocument | null> {
    const doc = this.docs.find((d) => d.indexStatus === 'pending');
    if (!doc) return Promise.resolve(null);
    doc.indexStatus = 'indexing';
    doc.indexAttempts += 1;
    return Promise.resolve({ id: doc.id, fileExtension: doc.fileExtension });
  }

  loadSections(documentId: string): Promise<ExtractedSection[]> {
    return Promise.resolve(this.docs.find((d) => d.id === documentId)?.sections ?? []);
  }

  replaceChunks(documentId: string, chunks: RagChunk[], embeddings: number[][]): Promise<number> {
    if (this.failReplace) {
      return Promise.reject(new Error('rpc unavailable'));
    }
    this.stored.set(documentId, { chunks, embeddings });
    return Promise.resolve(chunks.length);
  }

  markIndexed(documentId: string): Promise<void> {
    const doc = this.docs.find((d) => d.id === documentId)!;
    doc.indexStatus = 'indexed';
    doc.indexDetail = null;
    return Promise.resolve();
  }

  markIndexFailed(documentId: string, detail: string): Promise<void> {
    const doc = this.docs.find((d) => d.id === documentId)!;
    doc.indexStatus = 'failed';
    doc.indexDetail = detail;
    return Promise.resolve();
  }

  recoverStaleIndexing(): Promise<number> {
    let count = 0;
    for (const doc of this.docs) {
      if (doc.indexStatus === 'indexing') {
        doc.indexStatus = 'pending';
        count += 1;
      }
    }
    return Promise.resolve(count);
  }
}

const embeddings = new HashingEmbeddingProvider(32);

describe('indexNextDocument', () => {
  it('is idle when nothing is pending', async () => {
    const client = new FakeIndexerClient([]);
    await expect(indexNextDocument(client, embeddings)).resolves.toEqual({ status: 'idle' });
  });

  it('chunks, embeds, stores, and marks a ready document indexed', async () => {
    const doc: FakeDoc = {
      id: 'doc-1',
      fileExtension: 'pptx',
      indexStatus: 'pending',
      indexAttempts: 0,
      indexDetail: null,
      sections: [
        section({
          sectionType: 'slide_title',
          sequence: 0,
          slideNumber: 1,
          content: 'Heart Failure',
        }),
        section({
          sectionType: 'slide_body',
          sequence: 1,
          slideNumber: 1,
          content: 'Left-sided failure causes pulmonary congestion.',
        }),
      ],
    };
    const client = new FakeIndexerClient([doc]);
    const outcome = await indexNextDocument(client, embeddings);
    expect(outcome).toMatchObject({ status: 'indexed', documentId: 'doc-1', chunkCount: 1 });
    expect(doc.indexStatus).toBe('indexed');
    expect(doc.indexAttempts).toBe(1);

    const stored = client.stored.get('doc-1')!;
    expect(stored.chunks).toHaveLength(1);
    expect(stored.chunks[0]!.sourceLocator).toEqual({
      type: 'pptx',
      slide: 1,
      title: 'Heart Failure',
    });
    // One embedding per chunk, aligned by index.
    expect(stored.embeddings).toHaveLength(1);
    expect(stored.embeddings[0]).toHaveLength(32);
  });

  it('indexes an empty document as zero chunks (clears any stale ones)', async () => {
    const doc: FakeDoc = {
      id: 'doc-empty',
      fileExtension: 'txt',
      indexStatus: 'pending',
      indexAttempts: 0,
      indexDetail: null,
      sections: [],
    };
    const client = new FakeIndexerClient([doc]);
    const outcome = await indexNextDocument(client, embeddings);
    expect(outcome).toMatchObject({ status: 'indexed', chunkCount: 0 });
    expect(client.stored.get('doc-empty')!.chunks).toEqual([]);
    expect(doc.indexStatus).toBe('indexed');
  });

  it('marks the document failed with internal detail when storage fails', async () => {
    const doc: FakeDoc = {
      id: 'doc-2',
      fileExtension: 'txt',
      indexStatus: 'pending',
      indexAttempts: 0,
      indexDetail: null,
      sections: [section({ content: 'Some text.' })],
    };
    const client = new FakeIndexerClient([doc]);
    client.failReplace = true;
    const outcome = await indexNextDocument(client, embeddings);
    expect(outcome).toEqual({ status: 'failed', documentId: 'doc-2' });
    expect(doc.indexStatus).toBe('failed');
    expect(doc.indexDetail).toContain('rpc unavailable');
  });

  it('never claims the same document twice (CAS on pending)', async () => {
    const doc: FakeDoc = {
      id: 'doc-3',
      fileExtension: 'txt',
      indexStatus: 'pending',
      indexAttempts: 0,
      indexDetail: null,
      sections: [section({ content: 'Once only.' })],
    };
    const client = new FakeIndexerClient([doc]);
    await indexNextDocument(client, embeddings);
    await expect(indexNextDocument(client, embeddings)).resolves.toEqual({ status: 'idle' });
    expect(doc.indexAttempts).toBe(1);
  });
});

describe('drainIndexQueue', () => {
  it('indexes every pending document then stops', async () => {
    const make = (id: string): FakeDoc => ({
      id,
      fileExtension: 'txt',
      indexStatus: 'pending',
      indexAttempts: 0,
      indexDetail: null,
      sections: [section({ content: `Content of ${id}.` })],
    });
    const client = new FakeIndexerClient([make('a'), make('b'), make('c')]);
    const outcomes = await drainIndexQueue(client, embeddings);
    expect(outcomes.map((o) => o.status)).toEqual(['indexed', 'indexed', 'indexed']);
    expect(client.docs.every((d) => d.indexStatus === 'indexed')).toBe(true);
  });
});

describe('stale indexing recovery', () => {
  it('requeues stuck documents so they are retried, not failed', async () => {
    const doc: FakeDoc = {
      id: 'doc-stuck',
      fileExtension: 'txt',
      indexStatus: 'indexing',
      indexAttempts: 1,
      indexDetail: null,
      sections: [section({ content: 'Interrupted.' })],
    };
    const client = new FakeIndexerClient([doc]);
    await expect(client.recoverStaleIndexing()).resolves.toBe(1);
    expect(doc.indexStatus).toBe('pending');
    const outcome = await indexNextDocument(client, embeddings);
    expect(outcome).toMatchObject({ status: 'indexed', documentId: 'doc-stuck' });
  });
});
