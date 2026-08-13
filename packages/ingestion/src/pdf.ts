import { ExtractedSection, MAX_SECTION_CONTENT_CHARS } from '@avidia/domain';
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf';

import { ExtractionFailedError } from './types';
import { normalizeExtractedText } from './text';

/**
 * Below this many characters across the whole document, a PDF with pages is
 * treated as image-only (scanned) rather than text-based. OCR is deliberately
 * not attempted (ADR-0009); the document is marked as requiring OCR.
 */
const MIN_PDF_TEXT_CHARS = 25;

/** Split oversized page text into DB-sized sections without losing order. */
function splitContent(content: string): string[] {
  if (content.length <= MAX_SECTION_CONTENT_CHARS) {
    return [content];
  }
  const parts: string[] = [];
  let rest = content;
  while (rest.length > 0) {
    if (rest.length <= MAX_SECTION_CONTENT_CHARS) {
      parts.push(rest);
      break;
    }
    // Prefer to break at a line boundary near the limit.
    const window = rest.slice(0, MAX_SECTION_CONTENT_CHARS);
    const breakAt = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const cut = breakAt > MAX_SECTION_CONTENT_CHARS / 2 ? breakAt : MAX_SECTION_CONTENT_CHARS;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return parts.filter((part) => part.length > 0);
}

/**
 * Text-based PDF extraction with page provenance: one `page_text` section per
 * page (in page order), never a single flattened string. Encrypted and
 * malformed files map to specific failure codes; a PDF whose pages contain no
 * selectable text is reported as requiring OCR.
 */
export async function extractPdf(bytes: Uint8Array): Promise<ExtractedSection[]> {
  let pdf;
  try {
    pdf = await getDocument({
      data: bytes,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: true,
      verbosity: VerbosityLevel.ERRORS,
    }).promise;
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    if (name === 'PasswordException') {
      throw new ExtractionFailedError('encrypted', 'pdf: PasswordException');
    }
    throw new ExtractionFailedError('malformed', `pdf: ${name}`);
  }

  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const raw = textContent.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
        .join('');
      pages.push(normalizeExtractedText(raw));
    }

    const totalChars = pages.reduce((sum, text) => sum + text.length, 0);
    if (totalChars < MIN_PDF_TEXT_CHARS) {
      // Pages exist but effectively no selectable text: a scanned/image-only
      // (or genuinely blank) PDF. OCR is a documented later enhancement.
      throw new ExtractionFailedError(
        'ocr_required',
        `pdf: ${pdf.numPages} page(s), ${totalChars} extractable characters`
      );
    }

    const sections: ExtractedSection[] = [];
    pages.forEach((text, index) => {
      if (text.length === 0) {
        return; // e.g. a divider page; page numbers stay correct via pageNumber
      }
      for (const part of splitContent(text)) {
        sections.push({
          sectionType: 'page_text',
          sequence: sections.length,
          pageNumber: index + 1,
          slideNumber: null,
          heading: null,
          content: part,
          metadata: null,
        });
      }
    });
    return sections;
  } finally {
    await pdf.destroy().catch(() => {});
  }
}
