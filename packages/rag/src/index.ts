export {
  MAX_CHUNK_TOKENS,
  chunkSections,
  estimateTokens,
  splitTable,
  splitWithOverlap,
} from './chunking';
export {
  EMBEDDING_DIMENSION,
  EMBEDDING_VERSION,
  EmbeddingFailedError,
  HashingEmbeddingProvider,
  OpenAIEmbeddingProvider,
  createEmbeddingProviderFromEnv,
} from './embedding';
export { EVAL_CHUNKS, EVAL_QUERIES, asRetrievedChunk } from './evalFixtures';
export type { EvalChunk, EvalQuery } from './evalFixtures';
export { buildGroundingContext } from './grounding';
export type { CourseGroundingContext, GroundingSource } from './grounding';
export { CourseKnowledgeRetriever, describeLocator } from './retriever';
export type {
  EmbeddingMetadata,
  EmbeddingProvider,
  RagChunk,
  RetrievedChunk,
  SearchBackend,
  SearchRequest,
  SourceLocator,
} from './types';
