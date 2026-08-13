/**
 * Normalized extracted-content model (M4).
 *
 * A document_sections row is one structural unit of an uploaded material —
 * a PDF page's text, a slide's title/body/notes, a DOCX heading/paragraph/
 * list/table, or a TXT paragraph — in reading order, with its provenance
 * (page number, slide number, nearest heading) preserved. This is the input
 * contract for M5 semantic chunking; it deliberately contains no embeddings
 * and no AI-derived fields.
 */

export const SECTION_TYPES = [
  'heading',
  'paragraph',
  'list',
  'table',
  'slide_title',
  'slide_body',
  'slide_notes',
  'page_text',
] as const;

export type SectionType = (typeof SECTION_TYPES)[number];

/** Maximum characters a single section may carry (mirrors the DB CHECK). */
export const MAX_SECTION_CONTENT_CHARS = 20000;

/**
 * A structural unit extracted from a document, ready to persist.
 * `sequence` is the 0-based reading order within the document.
 */
export interface ExtractedSection {
  sectionType: SectionType;
  sequence: number;
  pageNumber: number | null;
  slideNumber: number | null;
  /** Nearest enclosing heading or slide title, for human-readable provenance. */
  heading: string | null;
  content: string;
  /** Parser-specific extras only (heading level, table size, …). */
  metadata: Record<string, unknown> | null;
}

/**
 * Human-readable source locator for a section, e.g. "slide 21", "page 8",
 * or "section “Postoperative Complications”". Used wherever the product needs
 * to say where a piece of content came from.
 */
export function describeSectionSource(section: {
  pageNumber: number | null;
  slideNumber: number | null;
  heading: string | null;
}): string {
  if (section.slideNumber != null) {
    return `slide ${section.slideNumber}`;
  }
  if (section.pageNumber != null) {
    return `page ${section.pageNumber}`;
  }
  if (section.heading) {
    return `section \u201c${section.heading}\u201d`;
  }
  return 'document';
}

/**
 * Validate a batch of sections before persistence: sequences must be the
 * gapless 0-based reading order, content must be non-empty and within the
 * database bound, and every section type must be known. Returns a list of
 * problems (empty = valid). The worker refuses to persist an invalid batch —
 * a document must never be READY with broken sections.
 */
export function validateSectionBatch(sections: readonly ExtractedSection[]): string[] {
  const problems: string[] = [];
  sections.forEach((section, index) => {
    if (section.sequence !== index) {
      problems.push(`section ${index}: sequence ${section.sequence} breaks reading order`);
    }
    if (!SECTION_TYPES.includes(section.sectionType)) {
      problems.push(`section ${index}: unknown section type "${section.sectionType}"`);
    }
    if (section.content.trim().length === 0) {
      problems.push(`section ${index}: empty content`);
    }
    if (section.content.length > MAX_SECTION_CONTENT_CHARS) {
      problems.push(`section ${index}: content exceeds ${MAX_SECTION_CONTENT_CHARS} characters`);
    }
  });
  return problems;
}
