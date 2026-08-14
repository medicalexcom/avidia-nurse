import { createHash } from 'crypto';

/**
 * Question deduplication (M7 spec R, ADR-0021).
 *
 * The content hash is SHA-256 over the question TYPE, the normalized stem,
 * and the normalized option texts sorted — so cosmetic differences (case,
 * punctuation, whitespace, option order) collapse into one hash, while
 * legitimately different questions about the same concept (different vitals,
 * different scenario, different asked action) stay distinct. The database
 * enforces uniqueness per course on this hash.
 */

/** Formatting-only text normalization; never changes letters or digits. */
export function normalizeQuestionText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f.]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function computeQuestionContentHash(
  questionType: string,
  stem: string,
  optionTexts: readonly string[]
): string {
  const hash = createHash('sha256');
  hash.update(questionType);
  hash.update('\u0000');
  hash.update(normalizeQuestionText(stem));
  for (const text of [...optionTexts].map(normalizeQuestionText).sort()) {
    hash.update('\u0000');
    hash.update(text);
  }
  return hash.digest('hex');
}
