import {
  EmbeddingProvider,
  RetrievedChunk,
  SearchBackend,
  SearchRequest,
  SourceLocator,
  SemanticContext,
} from './types';

/**
 * Course-scoped retrieval service with context-window optimization (Skill #2).
 * Screens and callers never query pgvector directly: they go through this service,
 * which embeds the query and delegates the scoped search to the backend
 * (the search_course_chunks RPC in production).
 *
 * Enhancement: Detects related chunks and can include them for reasoning chain preservation.
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
    const hits = await this.backend.searchChunks({
      courseId: request.courseId,
      query,
      queryEmbedding,
      topK: request.topK ?? 8,
      minSimilarity: request.minSimilarity ?? 0,
      documentId: request.documentId ?? null,
      preserveContext: request.preserveContext ?? false,
    });

    // If context preservation is requested, fetch and inject prerequisite/related chunks
    if (request.preserveContext && hits.length > 0) {
      return this.enrichWithContextChunks(hits, request.courseId, queryEmbedding);
    }

    return hits;
  }

  /**
   * Enhance retrieval results by including related chunks that form reasoning chains.
   * Example: if "DKA complications" is returned, also fetch "Glucose Metabolism" chunk
   * if it's in the same course (prerequisite context).
   */
  private async enrichWithContextChunks(
    hits: RetrievedChunk[],
    courseId: string,
    queryEmbedding: number[]
  ): Promise<RetrievedChunk[]> {
    // Extract concept terms from top hits
    const conceptTerms = new Set<string>();
    for (const hit of hits.slice(0, 3)) {
      if (hit.semanticContext?.containsConceptTerms) {
        hit.semanticContext.containsConceptTerms.forEach((term) => conceptTerms.add(term));
      }
    }

    if (conceptTerms.size === 0) {
      return hits;
    }

    // Build a context query to fetch related chunks
    // (concept terms + relationship markers)
    const contextQuery = Array.from(conceptTerms).join(' ');

    try {
      const relatedHits = await this.backend.searchChunks({
        courseId,
        query: contextQuery,
        queryEmbedding,
        topK: 4, // Fetch a few related chunks
        minSimilarity: 0.3, // Lower threshold for related content
        documentId: null,
        preserveContext: false,
      });

      // Merge and deduplicate: keep original hits, add related chunks that aren't duplicates
      const hitIds = new Set(hits.map((h) => h.chunkId));
      const enhanced = [...hits];

      for (const related of relatedHits) {
        if (!hitIds.has(related.chunkId)) {
          enhanced.push(related);
        }
      }

      // Re-sort by score, maintaining top results priority
      return enhanced.sort((a, b) => b.score - a.score);
    } catch {
      // If context enrichment fails, return original hits
      return hits;
    }
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
    parts.push(`section "${locator.heading}"`);
  } else {
    parts.push('document');
  }

  if (locator.title && locator.slide != null) {
    parts.push(`— ${locator.title}`);
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

/**
 * Describe semantic context for chunk relationships (used by UI/explanations).
 * Example: "This chunk contains clinical decision-making and relationship chains."
 */
export function describeSemanticContext(context: SemanticContext | undefined): string {
  if (!context) {
    return '';
  }

  const parts: string[] = [];

  if (context.containsConceptTerms && context.containsConceptTerms.length > 0) {
    parts.push(`Key concepts: ${context.containsConceptTerms.slice(0, 3).join(', ')}`);
  }

  if (context.hasRelationshipChain) {
    parts.push('Contains cause-effect reasoning');
  }

  if (context.readingLevel) {
    parts.push(`Reading level: ${context.readingLevel}`);
  }

  if (context.partIndex !== undefined && context.totalParts !== undefined && context.totalParts > 1) {
    parts.push(`(part ${context.partIndex}/${context.totalParts})`);
  }

  return parts.join('; ');
}
