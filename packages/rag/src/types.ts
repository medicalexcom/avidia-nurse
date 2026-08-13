import { MaterialExtension } from '@avidia/domain';

/**
 * Usable provenance carried by every chunk (spec F). Mirrors what the product
 * must be able to render: "Adult Health Module 3 — slide 17". Never discarded
 * after embedding.
 */
export interface SourceLocator {
  type: MaterialExtension;
  /** PDF page number (1-based). */
  page?: number;
  /** PPTX slide number (1-based, authoritative presentation order). */
  slide?: number;
  /** Slide title (PPTX). */
  title?: string;
  /** Nearest enclosing heading (DOCX/TXT). */
  heading?: string;
  /** First document_sections.sequence this chunk covers (DOCX/TXT locator). */
  sectionIndex?: number;
  /** Present when a single structural unit was split for size; 1-based. */
  part?: number;
  /** True when the chunk is a table preserved as pipe-delimited rows. */
  table?: boolean;
  /** True when the chunk is speaker notes rather than slide content. */
  notes?: boolean;
}

/** A semantic chunk derived from M4 sections, ready to embed and persist. */
export interface RagChunk {
  /** 0-based reading order of chunks within the document. */
  ordinal: number;
  content: string;
  /** Approximate token count (chars/4 heuristic) used by the size budget. */
  tokenEstimate: number;
  sourceLocator: SourceLocator;
  /** Inclusive document_sections.sequence range this chunk was built from. */
  sectionStart: number;
  sectionEnd: number;
}

/** Version metadata stored with every embedded chunk (spec B/J). */
export interface EmbeddingMetadata {
  provider: string;
  model: string;
  dimension: number;
  /**
   * Bumped whenever provider, model, OR the chunking algorithm changes in a
   * way that requires re-embedding. Rows carrying an older version are
   * re-indexable by resetting documents.index_status to 'pending'.
   */
  version: string;
}

/**
 * Provider-independent embeddings abstraction (spec B; Playbook §16 requires
 * provider-agnostic AI access — provider SDK types never leak past here).
 */
export interface EmbeddingProvider {
  /** Embed many chunk texts, preserving input order. Batches internally. */
  embedDocuments(texts: readonly string[]): Promise<number[][]>;
  /** Embed a retrieval query. */
  embedQuery(text: string): Promise<number[]>;
  metadata(): EmbeddingMetadata;
}

/** One retrieval hit, shaped for product use (spec M). */
export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  ordinal: number;
  content: string;
  sourceLocator: SourceLocator;
  /** Cosine similarity of the vector leg (0 when only the lexical leg hit). */
  similarity: number;
  /** Full-text rank of the lexical leg (0 when only the vector leg hit). */
  lexicalRank: number;
  /** Reciprocal-rank-fusion score used for the final ordering. */
  score: number;
}

export interface SearchRequest {
  courseId: string;
  query: string;
  topK?: number;
  minSimilarity?: number;
  documentId?: string;
}

/**
 * Seam between the retriever and the database (the search_course_chunks RPC
 * in production, an in-memory index in tests). Course/user authorization is
 * enforced INSIDE the database function, never by post-filtering results.
 */
export interface SearchBackend {
  searchChunks(params: {
    courseId: string;
    query: string;
    queryEmbedding: number[];
    topK: number;
    minSimilarity: number;
    documentId: string | null;
  }): Promise<RetrievedChunk[]>;
}
