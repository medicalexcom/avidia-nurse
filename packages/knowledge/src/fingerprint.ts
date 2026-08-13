import { createHash } from 'crypto';

import { ConceptExtractionMetadata } from './gateway';

/**
 * Knowledge fingerprint (M6 spec S — AI cost control).
 *
 * SHA-256 over the extraction configuration (provider, model, prompt version,
 * extraction version) and the exact chunk ids + contents of a document. The
 * worker compares this against documents.knowledge_fingerprint before calling
 * the AI provider: an unchanged fingerprint means the previous concepts are
 * still valid, so the run is skipped entirely — retries and idle re-drains
 * never pay for unchanged material.
 */
export function computeKnowledgeFingerprint(
  chunks: readonly { id: string; content: string }[],
  metadata: ConceptExtractionMetadata
): string {
  const hash = createHash('sha256');
  hash.update(
    [metadata.provider, metadata.model, metadata.promptVersion, metadata.extractionVersion].join(
      '\u0000'
    )
  );
  for (const chunk of chunks) {
    hash.update('\u0000');
    hash.update(chunk.id);
    hash.update('\u0000');
    hash.update(chunk.content);
  }
  return hash.digest('hex');
}
