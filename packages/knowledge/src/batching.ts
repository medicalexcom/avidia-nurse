import { ExtractionChunk } from './schema';

/**
 * Extraction batching (M6 spec S/V-costs): keep each AI call well under
 * context limits and avoid resending whole documents when chunk-level
 * batches are sufficient. Budgets use the same chars/4 token heuristic as
 * the M5 chunker.
 */
export const MAX_EXTRACTION_BATCH_TOKENS = 6000;
export const MAX_EXTRACTION_BATCH_CHUNKS = 12;

export function batchExtractionChunks(
  chunks: readonly ExtractionChunk[],
  maxTokens: number = MAX_EXTRACTION_BATCH_TOKENS,
  maxChunks: number = MAX_EXTRACTION_BATCH_CHUNKS
): ExtractionChunk[][] {
  const batches: ExtractionChunk[][] = [];
  let current: ExtractionChunk[] = [];
  let currentTokens = 0;
  for (const chunk of chunks) {
    const tokens = Math.ceil(chunk.content.length / 4);
    if (current.length > 0 && (currentTokens + tokens > maxTokens || current.length >= maxChunks)) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(chunk);
    currentTokens += tokens;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}
