import { ExtractedSection } from '@avidia/domain';

/**
 * Why an extraction could not produce usable content. Each code maps to one
 * safe, user-facing message in the worker; the raw detail stays internal.
 */
export type ExtractionFailureCode =
  | 'no_text' // parser ran, but the file contains no readable text
  | 'ocr_required' // PDF with pages but no selectable text (scanned images)
  | 'encrypted' // password-protected file
  | 'malformed' // corrupted / not actually the claimed format
  | 'unsupported'; // extension we do not extract

export class ExtractionFailedError extends Error {
  readonly code: ExtractionFailureCode;
  /** Internal diagnostic (parser error name, stage). Never shown to users. */
  readonly detail: string;

  constructor(code: ExtractionFailureCode, detail: string) {
    super(`extraction failed: ${code}`);
    this.name = 'ExtractionFailedError';
    this.code = code;
    this.detail = detail;
  }
}

export interface ExtractionResult {
  sections: ExtractedSection[];
}
