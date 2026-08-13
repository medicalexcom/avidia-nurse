import { describeLocator } from './retriever';
import { RetrievedChunk, SourceLocator } from './types';

/**
 * Grounding-context builder (spec N/R). Transforms retrieval results into the
 * labeled, source-attributed context a future AI answering call (M10 per the
 * Playbook) will consume. Every text block carries a stable source label
 * ([S1], [S2], …) that maps back to a chunk id and its provenance, so a
 * generated answer can cite "Adult Health Module 3 — slide 17" and the
 * platform can verify which chunks support which claims. Never a bare
 * unlabeled concatenation.
 */

export interface GroundingSource {
  /** Stable in-context label: S1, S2, … */
  label: string;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  sourceLocator: SourceLocator;
  /** Human-readable citation, e.g. "Adult Health Module 3 — slide 17". */
  citation: string;
  score: number;
}

export interface CourseGroundingContext {
  query: string;
  sources: GroundingSource[];
  /** One labeled block per source: "[S1] (citation)\ntext". */
  textBlocks: string[];
  /**
   * True when retrieval produced nothing usable. Callers MUST NOT attribute
   * an answer to course material when this is set (spec P: if the source
   * material does not support a claim, do not falsely attribute it; Playbook
   * §17: if retrieval is insufficient, label content platform-derived).
   */
  insufficient: boolean;
}

export function buildGroundingContext(
  query: string,
  results: readonly RetrievedChunk[]
): CourseGroundingContext {
  const sources: GroundingSource[] = results.map((result, index) => ({
    label: `S${index + 1}`,
    chunkId: result.chunkId,
    documentId: result.documentId,
    documentTitle: result.documentTitle,
    sourceLocator: result.sourceLocator,
    citation: `${result.documentTitle} \u2014 ${describeLocator(result.sourceLocator)}`,
    score: result.score,
  }));
  const textBlocks = results.map(
    (result, index) => `[${sources[index]!.label}] (${sources[index]!.citation})\n${result.content}`
  );
  return {
    query,
    sources,
    textBlocks,
    insufficient: results.length === 0,
  };
}
