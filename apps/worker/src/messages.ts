import { ExtractionFailedError, ExtractionFailureCode } from '@avidia/ingestion';

/**
 * Student-safe failure messages (spec K/N). These are the ONLY strings that
 * reach the documents.error_message column that clients can read. Stack
 * traces, parser internals, and file paths go to processing_detail, which is
 * not readable by authenticated users.
 */

export const GENERIC_FAILURE_MESSAGE = 'Processing did not complete. Please try again.';

const FAILURE_MESSAGES: Record<ExtractionFailureCode, string> = {
  encrypted:
    'This file is password-protected, so its text cannot be read. ' +
    'Please remove the password and upload it again.',
  ocr_required:
    'This document has no selectable text — it looks like scanned images. ' +
    'Text recognition (OCR) is not available yet, so it cannot be processed.',
  no_text: 'No readable text was found in this file. Please check the file and try again.',
  malformed:
    'This file could not be read. It may be damaged — try re-saving or re-exporting it, ' +
    'then upload it again.',
  unsupported: 'That file type is not supported. Please upload a PDF, PPTX, DOCX or TXT file.',
};

/** Map any processing error to a message a student may see. */
export function userMessageForError(error: unknown): string {
  if (error instanceof ExtractionFailedError) {
    return FAILURE_MESSAGES[error.code];
  }
  return GENERIC_FAILURE_MESSAGE;
}

/**
 * Internal diagnostic detail for processing_detail (never shown to users,
 * never allowed to carry document content — codes and error classes only).
 */
export function internalDetailForError(error: unknown): string {
  if (error instanceof ExtractionFailedError) {
    return `extraction_failed:${error.code}: ${error.detail}`.slice(0, 2000);
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 2000);
  }
  return errorMessage(error).slice(0, 2000);
}

/**
 * Best-effort message extraction for internal-only diagnostic fields
 * (index_detail, knowledge_detail, question_detail). `error instanceof
 * Error` alone is not enough here: supabase-js throws plain
 * `{message, code, details, hint}` objects (PostgrestError) for every
 * database-level failure - a failed RPC, a statement timeout, a constraint
 * violation - and those are NOT `instanceof Error`, so falling straight
 * through to `String(error)` silently collapses them to the useless literal
 * "[object Object]", exactly the kind of failure this repo's own comments
 * ("internal diagnostics only") intend these columns to actually explain.
 * Confirmed live (2026-08-15): a real replace_source_chunks statement
 * timeout was masked this way in index_detail; the real cause was only
 * recoverable via Postgres logs. This checks for a string `.message`
 * property before falling back to `String(error)`.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}
