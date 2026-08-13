import { HashingEmbeddingProvider } from './embedding';
import { EVAL_CHUNKS, EVAL_QUERIES, EvalChunk } from './evalFixtures';
import { CourseKnowledgeRetriever } from './retriever';
import { RetrievedChunk, SearchBackend } from './types';

/**
 * Retrieval-quality evaluation (spec S). Runs the synthetic nursing eval set
 * through the deterministic HashingEmbeddingProvider and an in-memory backend
 * that mirrors the search_course_chunks RPC: a vector leg (cosine), a lexical
 * leg (term overlap standing in for websearch_to_tsquery), and reciprocal-
 * rank-fusion (k=60) over both. This measures the retrieval pipeline's shape
 * honestly without network access; semantic quality with the production
 * OpenAI model can only be higher than this lexical baseline.
 */

const RRF_K = 60;

class InMemoryHybridBackend implements SearchBackend {
  private readonly embedded: { chunk: EvalChunk; vector: number[] }[] = [];

  private constructor() {}

  static async index(
    chunks: readonly EvalChunk[],
    embeddings: HashingEmbeddingProvider
  ): Promise<InMemoryHybridBackend> {
    const backend = new InMemoryHybridBackend();
    const vectors = await embeddings.embedDocuments(chunks.map((c) => c.content));
    chunks.forEach((chunk, i) => backend.embedded.push({ chunk, vector: vectors[i]! }));
    return backend;
  }

  searchChunks(params: {
    courseId: string;
    query: string;
    queryEmbedding: number[];
    topK: number;
    minSimilarity: number;
    documentId: string | null;
  }): Promise<RetrievedChunk[]> {
    const pool = this.embedded.filter(
      (e) => params.documentId === null || e.chunk.documentId === params.documentId
    );

    // Vector leg: cosine similarity (vectors are L2-normalized → dot product).
    const vectorLeg = pool
      .map((e) => ({
        e,
        sim: e.vector.reduce((sum, v, i) => sum + v * params.queryEmbedding[i]!, 0),
      }))
      .sort((a, z) => z.sim - a.sim);

    // Lexical leg: distinct query-term overlap, mirroring full-text search.
    const terms = new Set(params.query.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    const lexicalLeg = pool
      .map((e) => {
        const content = e.chunk.content.toLowerCase();
        let hits = 0;
        for (const term of terms) {
          if (content.includes(term)) {
            hits += 1;
          }
        }
        return { e, hits };
      })
      .filter((x) => x.hits > 0)
      .sort((a, z) => z.hits - a.hits);

    const fused = new Map<string, { sim: number; lrank: number; score: number }>();
    vectorLeg.forEach(({ e, sim }, rank) => {
      fused.set(e.chunk.id, { sim, lrank: 0, score: 1 / (RRF_K + rank + 1) });
    });
    lexicalLeg.forEach(({ e }, rank) => {
      const prev = fused.get(e.chunk.id) ?? { sim: 0, lrank: 0, score: 0 };
      prev.lrank = rank + 1;
      prev.score += 1 / (RRF_K + rank + 1);
      fused.set(e.chunk.id, prev);
    });

    const byId = new Map(pool.map((e) => [e.chunk.id, e.chunk]));
    const results = [...fused.entries()]
      .filter(([, f]) => f.sim >= params.minSimilarity || f.lrank > 0)
      .sort((a, z) => z[1].score - a[1].score)
      .slice(0, params.topK)
      .map(([id, f]) => {
        const chunk = byId.get(id)!;
        return {
          chunkId: chunk.id,
          documentId: chunk.documentId,
          documentTitle: chunk.documentTitle,
          ordinal: chunk.ordinal,
          content: chunk.content,
          sourceLocator: chunk.sourceLocator,
          similarity: f.sim,
          lexicalRank: f.lrank,
          score: f.score,
        };
      });
    return Promise.resolve(results);
  }
}

describe('retrieval quality on the synthetic nursing eval set', () => {
  const embeddings = new HashingEmbeddingProvider();
  let retriever: CourseKnowledgeRetriever;

  beforeAll(async () => {
    const backend = await InMemoryHybridBackend.index(EVAL_CHUNKS, embeddings);
    retriever = new CourseKnowledgeRetriever(backend, embeddings);
  });

  it('surfaces every expected chunk at rank 1 (hit@1 = 100% on the baseline)', async () => {
    for (const evalQuery of EVAL_QUERIES) {
      const results = await retriever.search({ courseId: 'course-1', query: evalQuery.query });
      expect(results.length).toBeGreaterThan(0);
      for (const expected of evalQuery.expectedChunkIds) {
        expect(results[0]!.chunkId).toBe(expected);
      }
    }
  });

  it('achieves hit@3 = 100% across the eval set', async () => {
    let hits = 0;
    let total = 0;
    for (const evalQuery of EVAL_QUERIES) {
      const results = await retriever.search({
        courseId: 'course-1',
        query: evalQuery.query,
        topK: 3,
      });
      const top3 = new Set(results.map((r) => r.chunkId));
      for (const expected of evalQuery.expectedChunkIds) {
        total += 1;
        if (top3.has(expected)) {
          hits += 1;
        }
      }
    }
    expect(hits / total).toBe(1);
  });

  it('finds exact clinical terms through the lexical leg (FEV1, PaCO2, Kussmaul)', async () => {
    for (const [term, expected] of [
      ['FEV1', 'chunk-copd'],
      ['PaCO2', 'chunk-copd'],
      ['Kussmaul', 'chunk-dka'],
      ['furosemide', 'chunk-furosemide'],
    ] as const) {
      const results = await retriever.search({ courseId: 'course-1', query: term });
      expect(results[0]!.chunkId).toBe(expected);
      expect(results[0]!.lexicalRank).toBeGreaterThan(0);
    }
  });

  it('respects a document filter', async () => {
    const results = await retriever.search({
      courseId: 'course-1',
      query: 'potassium',
      documentId: 'doc-endo',
    });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.documentId).toBe('doc-endo');
    }
  });

  it('carries provenance through retrieval untouched', async () => {
    const results = await retriever.search({
      courseId: 'course-1',
      query: 'pulmonary embolism Virchow triad D-dimer',
    });
    expect(results[0]!.sourceLocator).toEqual({
      type: 'pptx',
      slide: 17,
      title: 'Pulmonary Embolism',
    });
    expect(results[0]!.documentTitle).toBe('Respiratory Emergencies');
  });

  it('returns nothing useful for a query the material does not cover', async () => {
    const results = await retriever.search({
      courseId: 'course-1',
      query: 'zzzunknown qqqterm xyzzy',
      minSimilarity: 0.2,
    });
    // With a similarity threshold and no lexical hits, uncovered queries
    // come back empty — the grounding builder will mark them insufficient.
    expect(results).toEqual([]);
  });

  it('honors topK', async () => {
    const results = await retriever.search({
      courseId: 'course-1',
      query: 'potassium monitoring',
      topK: 2,
    });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});
