import { MaterialExtension, validateSectionBatch } from '@avidia/domain';

import { extractDocx } from './docx';
import { extractPdf } from './pdf';
import { extractPptx } from './pptx';
import { extractTxt } from './text';
import { ExtractionFailedError, ExtractionResult } from './types';

export { ExtractionFailedError } from './types';
export type { ExtractionFailureCode, ExtractionResult } from './types';
export { normalizeExtractedText } from './text';
// Test-fixture builders (spec S): deterministic in-memory PDFs/PPTX/DOCX used
// by ingestion and worker tests. Never used in production code paths.
export * from './fixtures';

/**
 * Extract and normalize an uploaded material into ordered, provenance-
 * preserving sections (ADR-0010). Deterministic parsers only — no AI, no
 * network, no OCR (image-only PDFs fail with `ocr_required`).
 *
 * Throws ExtractionFailedError with a specific code on any unusable input;
 * a successful return always carries at least one valid section, so a
 * document can never be marked READY with empty or broken content.
 */
export async function extractDocument(
  bytes: Uint8Array,
  extension: MaterialExtension
): Promise<ExtractionResult> {
  let sections;
  switch (extension) {
    case 'pdf':
      sections = await extractPdf(bytes);
      break;
    case 'pptx':
      sections = await extractPptx(bytes);
      break;
    case 'docx':
      sections = await extractDocx(bytes);
      break;
    case 'txt':
      sections = extractTxt(bytes);
      break;
    default: {
      const never: never = extension;
      throw new ExtractionFailedError('unsupported', `extension ${String(never)}`);
    }
  }

  // Extraction-quality gate (spec N): zero usable content is a failure, and a
  // batch that violates the section contract must never reach the database.
  if (sections.length === 0) {
    throw new ExtractionFailedError('no_text', `${extension}: parser produced no sections`);
  }
  const problems = validateSectionBatch(sections);
  if (problems.length > 0) {
    throw new ExtractionFailedError('malformed', `${extension}: ${problems[0]}`);
  }

  return { sections };
}
