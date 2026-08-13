import {
  EmbeddingProvider,
  RetrievedChunk,
  SearchBackend,
  SearchRequest,
  SourceLocator,
} from './types';

/**
 * Course-scoped retrieval service (spec M). Screens and callers never query
 * pgvector directly: they go through this service, which embeds the query and
 * delegates the scoped search to the backend (the search_course_chunks RPC in
 * production). Ownership authorization lives in the database function — the
 * retriever cannot weaken it, and forgetting a filter here cannot leak
 * another user's chunks.
 */
export class CourseKnowledgeRetriever {
  constructor(
    private readonly backend: SearchBackend,
    private readonly embeddings: EmbeddingProvider
  ) {}

  async search(request: SearchRequest): Promise<RetrievedChunk[]> {
    const query = request.query.trim();
    if (query.length === 0) {
      return [];
    }
    const queryEmbedding = await this.embeddings.embedQuery(query);
    return this.backend.searchChunks({
      courseId: request.courseId,
      query,
      queryEmbedding,
      topK: request.topK ?? 8,
      minSimilarity: request.minSimilarity ?? 0,
      documentId: request.documentId ?? null,
    });
  }
}

/** Human-readable source label, e.g. "slide 17 — Pulmonary Embolism". */
export function describeLocator(locator: SourceLocator): string {
  const parts: string[] = [];
  if (locator.slide != null) {
    parts.push(`slide ${locator.slide}`);
  } else if (locator.page != null) {
    parts.push(`page ${locator.page}`);
  } else if (locator.heading) {
    parts.push(`section \u201c${locator.heading}\u201d`);
  } else {
    parts.push('document');
  }
  if (locator.title && locator.slide != null) {
    parts.push(`\u2014 ${locator.title}`);
  }
  if (locator.table) {
    parts.push('(table)');
  }
  if (locator.notes) {
    parts.push('(speaker notes)');
  }
  if (locator.part != null) {
    parts.push(`(part ${locator.part})`);
  }
  return parts.join(' ');
}
