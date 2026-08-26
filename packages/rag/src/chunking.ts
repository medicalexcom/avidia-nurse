import { ExtractedSection, MaterialExtension } from '@avidia/domain';

import { RagChunk, SourceLocator, SemanticContext } from './types';

/**
 * Advanced semantic chunking with concept relationship preservation (Skill #2).
 *
 * Structural semantic chunking (spec D, ADR-0011) enhanced with:
 *   - Concept boundary detection: never split related concepts (e.g., Glucose → DKA chain)
 *   - Cross-reference indexing: mark chunks that cite prerequisites or cause concepts
 *   - Context window optimization: maintain reasoning chains within chunks
 *   - Hierarchical chunking: preserve heading/section hierarchy for better grounding
 *
 * Size budget: ~480 tokens (chars/4 heuristic) per chunk, but flexible for concept
 * preservation (may exceed by 20% to keep related concepts together).
 */

export const MAX_CHUNK_TOKENS = 480;
export const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * 4;
export const MAX_CHUNK_CHARS_WITH_CONTEXT_BONUS = Math.floor(MAX_CHUNK_CHARS * 1.2);
/** Max characters of trailing context carried into the next split part. */
const MAX_OVERLAP_CHARS = 240;

/**
 * Keywords/phrases that indicate concept boundaries (used by concept-aware chunking).
 * These phrases signal "this is likely a new major concept" or prerequisite relationship.
 */
export const CONCEPT_BOUNDARY_MARKERS = [
  'first, let\'s review',
  'before we discuss',
  'you must understand',
  'prerequisite:',
  'foundation:',
  'underlying concept:',
  'causes of',
  'mechanism of',
  'pathophysiology of',
  'clinical presentation of',
  'complications of',
  'management of',
  'why this matters',
  'related concept:',
] as const;

/**
 * Keywords that indicate causality/relationship chains (preserved within chunks).
 */
export const RELATIONSHIP_MARKERS = [
  'leads to',
  'causes',
  'caused by',
  'results in',
  'therefore',
  'as a result',
  'which means',
  'this is why',
  'because of this',
  'consequence:',
  'related to',
  'associated with',
] as const;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

interface Builder {
  chunks: RagChunk[];
  pendingSemanticContext: SemanticContext | null;
}

function push(
  b: Builder,
  content: string,
  locator: SourceLocator,
  sectionStart: number,
  sectionEnd: number,
  semanticContext: SemanticContext | null = null
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
    semanticContext: semanticContext || undefined,
  });
}

/**
 * Detect if text contains concept boundary markers (indicates new major concept).
 */
function hasConceptBoundary(text: string): boolean {
  const lower = text.toLowerCase();
  return CONCEPT_BOUNDARY_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Detect if text contains relationship markers (indicates cause/effect chain).
 */
function hasRelationshipMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return RELATIONSHIP_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Extract potential concept keywords from text (capitalized phrases, common medical terms).
 * Used to build semantic context for cross-reference indexing.
 */
function extractConceptTerms(text: string): string[] {
  const terms: string[] = [];
  // Match capitalized phrases (likely proper nouns/concepts)
  const matches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
  terms.push(...matches);
  // Common medical terms we care about
  const medicalTerms = text.match(/\b(syndrome|disease|disorder|metabolism|pathophysiology|mechanism|complication|symptom|sign|assessment|intervention|medication|drug|treatment|therapy|diagnosis|diagnostic|clinical|nurse|patient)\b/gi) || [];
  terms.push(...medicalTerms);
  return [...new Set(terms)];
}

/**
 * Split an oversized text at line (then word) boundaries, respecting concept boundaries.
 * If a concept boundary marker is found before the hard split, prefer splitting there.
 */
export function splitWithOverlap(
  text: string,
  maxChars = MAX_CHUNK_CHARS,
  allowContextBonus = true
): string[] {
  const effectiveMax = allowContextBonus ? MAX_CHUNK_CHARS_WITH_CONTEXT_BONUS : maxChars;

  if (text.length <= maxChars) {
    return [text];
  }

  const parts: string[] = [];
  let rest = text;
  let carry = '';

  while (rest.length > 0) {
    const budget = effectiveMax - carry.length;

    if (rest.length <= budget) {
      parts.push((carry + rest).trim());
      break;
    }

    const window = rest.slice(0, budget);

    // Try to find a concept boundary marker first (soft split point)
    let conceptBoundaryCut = -1;
    for (const marker of CONCEPT_BOUNDARY_MARKERS) {
      const idx = window.toLowerCase().indexOf(marker);
      if (idx > budget / 2) {
        // Found a boundary marker in the right half — prefer splitting before it
        conceptBoundaryCut = Math.max(conceptBoundaryCut, idx);
      }
    }

    // If found a concept boundary, split there; otherwise use line/word boundary
    let cut = conceptBoundaryCut > 0 ? conceptBoundaryCut : window.lastIndexOf('\n');

    if (cut < budget / 2) {
      cut = window.lastIndexOf(' ');
    }

    const hardSplit = cut < budget / 2;
    if (hardSplit) {
      cut = budget;
    }

    const piece = rest.slice(0, cut).trim();
    parts.push((carry + piece).trim());
    rest = rest.slice(cut).trim();

    const lastLine = piece.slice(piece.lastIndexOf('\n') + 1).trim();
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
  splitter: (text: string) => string[] = (text) => splitWithOverlap(text, MAX_CHUNK_CHARS, true)
): void {
  const parts = splitter(content);
  const conceptTerms = extractConceptTerms(content);
  const hasRelationship = hasRelationshipMarker(content);

  parts.forEach((part, index) => {
    const withPart = parts.length > 1 ? { ...locator, part: index + 1 } : locator;
    const semanticContext: SemanticContext = {
      containsConceptTerms: conceptTerms,
      hasRelationshipChain: hasRelationship,
      partIndex: index,
      totalParts: parts.length,
    };
    push(b, part, withPart, sectionStart, sectionEnd, semanticContext);
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
      pushSplit(
        b,
        content,
        { ...base, table: true },
        table.sequence,
        table.sequence,
        (text) => splitTable(text)
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

    // Check if adding this section would exceed budget OR hit a concept boundary
    const wouldExceedBudget = groupChars + section.content.length > MAX_CHUNK_CHARS && group.length > 0;
    const hasBoundaryMarker = hasConceptBoundary(section.content);

    if ((wouldExceedBudget || hasBoundaryMarker) && group.length > 0) {
      flush();
      if (hasBoundaryMarker) {
        // Start new group with the boundary marker content
        heading = null; // Reset heading for new section
      }
    }

    group.push(section);
    groupChars += section.content.length + 2;
  }

  flush();
}

/**
 * Turn a READY document's M4 sections into ordered semantic chunks with
 * relationship context preserved.
 * Deterministic: same sections in, same chunks out — re-indexing converges.
 */
export function chunkSections(
  sections: readonly ExtractedSection[],
  extension: MaterialExtension
): RagChunk[] {
  const b: Builder = { chunks: [], pendingSemanticContext: null };
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
