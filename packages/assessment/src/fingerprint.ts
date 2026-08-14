import { createHash } from 'crypto';

import { QuestionGenerationMetadata } from './gateway';

/**
 * Question-generation fingerprint (M7 spec Y/AD — AI cost control).
 *
 * SHA-256 over the generation configuration (provider, model, prompt version,
 * generation version), the concept keys the document evidences, and the exact
 * chunk ids + contents. The worker compares this against
 * documents.question_fingerprint before calling the AI provider: an unchanged
 * fingerprint means the existing question pool is still valid, so the run is
 * skipped entirely — retries and idle re-drains never pay for unchanged
 * material.
 */
export function computeQuestionFingerprint(
  conceptKeys: readonly string[],
  chunks: readonly { id: string; content: string }[],
  metadata: QuestionGenerationMetadata
): string {
  const hash = createHash('sha256');
  hash.update(
    [metadata.provider, metadata.model, metadata.promptVersion, metadata.generationVersion].join(
      '\u0000'
    )
  );
  for (const key of [...conceptKeys].sort()) {
    hash.update('\u0000');
    hash.update(key);
  }
  for (const chunk of chunks) {
    hash.update('\u0000');
    hash.update(chunk.id);
    hash.update('\u0000');
    hash.update(chunk.content);
  }
  return hash.digest('hex');
}
