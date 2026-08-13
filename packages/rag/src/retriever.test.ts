import { HashingEmbeddingProvider } from './embedding';
import { CourseKnowledgeRetriever, describeLocator } from './retriever';
import { RetrievedChunk, SearchBackend } from './types';

describe('CourseKnowledgeRetriever', () => {
  function makeBackend(results: RetrievedChunk[] = []) {
    const calls: Parameters<SearchBackend['searchChunks']>[0][] = [];
    const backend: SearchBackend = {
      searchChunks: (params) => {
        calls.push(params);
        return Promise.resolve(results);
      },
    };
    return { backend, calls };
  }

  const embeddings = new HashingEmbeddingProvider(8);

  it('passes the course scope and defaults to the backend', async () => {
    const { backend, calls } = makeBackend();
    const retriever = new CourseKnowledgeRetriever(backend, embeddings);
    await retriever.search({ courseId: 'course-1', query: 'heart failure' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      courseId: 'course-1',
      query: 'heart failure',
      topK: 8,
      minSimilarity: 0,
      documentId: null,
    });
    expect(calls[0]!.queryEmbedding).toHaveLength(8);
  });

  it('forwards explicit topK, threshold, and document filter', async () => {
    const { backend, calls } = makeBackend();
    const retriever = new CourseKnowledgeRetriever(backend, embeddings);
    await retriever.search({
      courseId: 'course-1',
      query: 'DKA',
      topK: 3,
      minSimilarity: 0.4,
      documentId: 'doc-9',
    });
    expect(calls[0]).toMatchObject({ topK: 3, minSimilarity: 0.4, documentId: 'doc-9' });
  });

  it('returns [] for an empty query without touching the backend', async () => {
    const { backend, calls } = makeBackend();
    const retriever = new CourseKnowledgeRetriever(backend, embeddings);
    await expect(retriever.search({ courseId: 'c', query: '   ' })).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('describeLocator', () => {
  it('describes slides with titles', () => {
    expect(describeLocator({ type: 'pptx', slide: 17, title: 'Pulmonary Embolism' })).toBe(
      'slide 17 \u2014 Pulmonary Embolism'
    );
  });

  it('describes pages, headings, and bare documents', () => {
    expect(describeLocator({ type: 'pdf', page: 8 })).toBe('page 8');
    expect(describeLocator({ type: 'docx', heading: 'DKA' })).toBe('section \u201cDKA\u201d');
    expect(describeLocator({ type: 'txt' })).toBe('document');
  });

  it('annotates tables, notes, and split parts', () => {
    expect(describeLocator({ type: 'pptx', slide: 3, table: true })).toBe('slide 3 (table)');
    expect(describeLocator({ type: 'pptx', slide: 3, notes: true })).toBe(
      'slide 3 (speaker notes)'
    );
    expect(describeLocator({ type: 'pdf', page: 2, part: 2 })).toBe('page 2 (part 2)');
  });
});
