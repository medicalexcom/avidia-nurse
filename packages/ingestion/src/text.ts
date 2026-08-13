import { ExtractedSection } from '@avidia/domain';

/**
 * Normalize extracted text: unify newlines, drop control characters (except
 * tab/newline), collapse runs of spaces, and trim line edges. Deterministic
 * and lossless with respect to words and line structure.
 */
export function normalizeExtractedText(raw: string): string {
  return (
    raw
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex -- deliberately stripping control chars
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Conservative heading detection for plain text: a paragraph is a heading
 * only when it is a single short line without terminal sentence punctuation
 * AND is either markdown-style ("# Heading") or written in ALL CAPS. Anything
 * ambiguous stays a paragraph — we do not invent structure (spec E).
 */
function detectHeading(paragraph: string): string | null {
  if (paragraph.includes('\n') || paragraph.length > 80) {
    return null;
  }
  const markdown = paragraph.match(/^#{1,6}\s+(.+)$/);
  if (markdown) {
    return markdown[1]!.trim();
  }
  if (/[.!?:;,]$/.test(paragraph)) {
    return null;
  }
  const letters = paragraph.replace(/[^a-zA-Z]/g, '');
  if (letters.length >= 3 && letters === letters.toUpperCase()) {
    return paragraph;
  }
  return null;
}

/**
 * TXT / pasted-notes extraction: normalize, split into paragraphs on blank
 * lines, keep order, and tag conservative headings so later provenance can
 * say "Notes → section 'Postoperative Complications'".
 */
export function extractTxt(bytes: Uint8Array): ExtractedSection[] {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  const normalized = normalizeExtractedText(text);
  if (normalized.length === 0) {
    return [];
  }

  const sections: ExtractedSection[] = [];
  let currentHeading: string | null = null;
  for (const paragraph of normalized.split(/\n{2,}/)) {
    const content = paragraph.trim();
    if (content.length === 0) {
      continue;
    }
    const heading = detectHeading(content);
    if (heading !== null) {
      currentHeading = heading;
      sections.push({
        sectionType: 'heading',
        sequence: sections.length,
        pageNumber: null,
        slideNumber: null,
        heading: null,
        content: heading,
        metadata: null,
      });
    } else {
      sections.push({
        sectionType: 'paragraph',
        sequence: sections.length,
        pageNumber: null,
        slideNumber: null,
        heading: currentHeading,
        content,
        metadata: null,
      });
    }
  }
  return sections;
}
