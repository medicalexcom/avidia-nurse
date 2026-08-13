import { ExtractedSection, MaterialExtension } from '@avidia/domain';

import { RagChunk, SourceLocator } from './types';

/**
 * Structural semantic chunking (spec D, ADR-0011).
 *
 * Chunks are built around the structural boundaries M4 preserved — never by
 * blind character windows:
 *   * PPTX: one chunk per slide (title + body), plus separate chunks for each
 *     table and for speaker notes. The slide is the semantic unit.
 *   * PDF: one chunk per page; oversized pages split at line boundaries with
 *     a one-line structural overlap so split points keep their context.
 *   * DOCX/TXT: heading-scoped groups — a heading and its following
 *     paragraphs/lists accumulate into a chunk up to the size budget; tables
 *     become their own chunks (with the header row repeated on splits).
 *
 * Size budget: ~480 tokens (chars/4 heuristic) per chunk. This fits every
 * mainstream embedding model comfortably and keeps retrieval hits focused.
 */

export const MAX_CHUNK_TOKENS = 480;
const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * 4;
/** Max characters of trailing context carried into the next split part. */
const MAX_OVERLAP_CHARS = 240;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

interface Builder {
  chunks: RagChunk[];
}

function push(
  b: Builder,
  content: string,
  locator: SourceLocator,
  sectionStart: number,
  sectionEnd: number
): void {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return;
  }
  b.chunks.push({
    ordinal: b.chunks.length,
    content: trimmed,
    tokenEstimate: estimateTokens(trimmed),
    sourceLocator: locator,
    sectionStart,
    sectionEnd,
  });
}

/**
 * Split an oversized text at line (then word) boundaries. Each subsequent
 * part starts with the previous part's final line as structural overlap
 * (spec G): continuity without wholesale duplication.
 */
export function splitWithOverlap(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  const parts: string[] = [];
  let rest = text;
  let carry = '';
  while (rest.length > 0) {
    const budget = maxChars - carry.length;
    if (rest.length <= budget) {
      parts.push((carry + rest).trim());
      break;
    }
    const window = rest.slice(0, budget);
    let cut = window.lastIndexOf('\n');
    if (cut < budget / 2) {
      cut = window.lastIndexOf(' ');
    }
    const hardSplit = cut < budget / 2;
    if (hardSplit) {
      cut = budget; // single enormous token: hard split, no boundary exists
    }
    const piece = rest.slice(0, cut).trim();
    parts.push((carry + piece).trim());
    rest = rest.slice(cut).trim();
    const lastLine = piece.slice(piece.lastIndexOf('\n') + 1).trim();
    // Overlap only where a structural boundary exists (spec G): a hard split
    // has no meaningful "last line" — carrying it would duplicate the piece.
    carry =
      !hardSplit && lastLine.length > 0 && lastLine.length <= MAX_OVERLAP_CHARS
        ? `${lastLine}\n`
        : '';
  }
  return parts.filter((part) => part.length > 0);
}

/**
 * Split an oversized pipe-delimited table at row boundaries, repeating the
 * header row in every part so rows never lose their column meaning (spec H).
 */
export function splitTable(content: string, maxChars = MAX_CHUNK_CHARS): string[] {
  if (content.length <= maxChars) {
    return [content];
  }
  const rows = content.split('\n');
  const header = rows[0] ?? '';
  const parts: string[] = [];
  let current: string[] = [header];
  let size = header.length;
  for (const row of rows.slice(1)) {
    if (size + row.length + 1 > maxChars && current.length > 1) {
      parts.push(current.join('\n'));
      current = [header];
      size = header.length;
    }
    current.push(row);
    size += row.length + 1;
  }
  if (current.length > 1) {
    parts.push(current.join('\n'));
  }
  return parts;
}

function pushSplit(
  b: Builder,
  content: string,
  locator: SourceLocator,
  sectionStart: number,
  sectionEnd: number,
  splitter: (text: string) => string[] = splitWithOverlap
): void {
  const parts = splitter(content);
  parts.forEach((part, index) => {
    const withPart = parts.length > 1 ? { ...locator, part: index + 1 } : locator;
    push(b, part, withPart, sectionStart, sectionEnd);
  });
}

function chunkPptx(sections: readonly ExtractedSection[], b: Builder): void {
  const bySlide = new Map<number, ExtractedSection[]>();
  for (const section of sections) {
    const slide = section.slideNumber ?? 0;
    const list = bySlide.get(slide) ?? [];
    list.push(section);
    bySlide.set(slide, list);
  }
  for (const slide of [...bySlide.keys()].sort((a, z) => a - z)) {
    const slideSections = bySlide.get(slide)!;
    const title =
      slideSections.find((s) => s.sectionType === 'slide_title')?.content ??
      slideSections[0]!.heading ??
      undefined;
    const base: SourceLocator = { type: 'pptx', slide };
    if (title) {
      base.title = title;
    }

    // Title + body form the slide's core chunk.
    const core = slideSections
      .filter((s) => s.sectionType === 'slide_title' || s.sectionType === 'slide_body')
      .map((s) => s.content)
      .join('\n');
    const coreSeqs = slideSections
      .filter((s) => s.sectionType === 'slide_title' || s.sectionType === 'slide_body')
      .map((s) => s.sequence);
    if (core.trim().length > 0) {
      pushSplit(b, core, base, Math.min(...coreSeqs), Math.max(...coreSeqs));
    }

    for (const table of slideSections.filter((s) => s.sectionType === 'table')) {
      const content = title ? `${title}\n${table.content}` : table.content;
      pushSplit(b, content, { ...base, table: true }, table.sequence, table.sequence, (text) =>
        splitTable(text)
      );
    }
    for (const notes of slideSections.filter((s) => s.sectionType === 'slide_notes')) {
      pushSplit(b, notes.content, { ...base, notes: true }, notes.sequence, notes.sequence);
    }
  }
}

function chunkPdf(sections: readonly ExtractedSection[], b: Builder): void {
  // M4 may already have split an enormous page into multiple page_text
  // sections; group by page so a page is one semantic unit again, then apply
  // the size budget.
  const byPage = new Map<number, ExtractedSection[]>();
  for (const section of sections) {
    const page = section.pageNumber ?? 0;
    const list = byPage.get(page) ?? [];
    list.push(section);
    byPage.set(page, list);
  }
  for (const page of [...byPage.keys()].sort((a, z) => a - z)) {
    const pageSections = byPage.get(page)!;
    const content = pageSections.map((s) => s.content).join('\n');
    const seqs = pageSections.map((s) => s.sequence);
    pushSplit(b, content, { type: 'pdf', page }, Math.min(...seqs), Math.max(...seqs));
  }
}

function chunkHeadingFlow(
  sections: readonly ExtractedSection[],
  type: MaterialExtension,
  b: Builder
): void {
  let heading: string | null = null;
  let group: ExtractedSection[] = [];
  let groupChars = 0;

  const locatorFor = (start: ExtractedSection): SourceLocator => {
    const locator: SourceLocator = { type, sectionIndex: start.sequence };
    if (heading) {
      locator.heading = heading;
    }
    return locator;
  };

  const flush = () => {
    if (group.length === 0) {
      return;
    }
    const start = group[0]!;
    const content = group.map((s) => s.content).join('\n\n');
    pushSplit(b, content, locatorFor(start), start.sequence, group[group.length - 1]!.sequence);
    group = [];
    groupChars = 0;
  };

  for (const section of sections) {
    if (section.sectionType === 'heading') {
      flush();
      heading = section.content;
      group = [section];
      groupChars = section.content.length;
      continue;
    }
    if (section.sectionType === 'table') {
      flush();
      const content = heading ? `${heading}\n${section.content}` : section.content;
      const locator: SourceLocator = { type, sectionIndex: section.sequence, table: true };
      if (heading) {
        locator.heading = heading;
      }
      pushSplit(b, content, locator, section.sequence, section.sequence, (text) =>
        splitTable(text)
      );
      continue;
    }
    if (groupChars + section.content.length > MAX_CHUNK_CHARS && group.length > 0) {
      flush();
    }
    group.push(section);
    groupChars += section.content.length + 2;
  }
  flush();
}

/**
 * Turn a READY document's M4 sections into ordered semantic chunks.
 * Deterministic: same sections in, same chunks out — re-indexing converges.
 */
export function chunkSections(
  sections: readonly ExtractedSection[],
  extension: MaterialExtension
): RagChunk[] {
  const b: Builder = { chunks: [] };
  const ordered = [...sections].sort((a, z) => a.sequence - z.sequence);
  if (extension === 'pptx') {
    chunkPptx(ordered, b);
  } else if (extension === 'pdf') {
    chunkPdf(ordered, b);
  } else {
    chunkHeadingFlow(ordered, extension, b);
  }
  return b.chunks;
}
