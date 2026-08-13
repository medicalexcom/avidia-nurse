import { ExtractedSection } from '@avidia/domain';

import {
  attrsOf,
  childrenOf,
  findFirst,
  gatherText,
  nodeName,
  openOoxmlArchive,
  readArchiveXml,
  XmlNode,
} from './ooxml';
import { ExtractionFailedError } from './types';

/**
 * DOCX extraction (spec D): walk the document body in order, preserving
 * headings (from paragraph styles), paragraphs, lists (consecutive numbered/
 * bulleted paragraphs merge into one list section), and tables. Sections
 * carry the nearest heading, so provenance reads
 * "Study Guide → section 'Postoperative Complications'".
 */

function paragraphStyle(paragraph: XmlNode): string | null {
  const pPr = findFirst(childrenOf(paragraph), 'w:pPr');
  if (!pPr) {
    return null;
  }
  const style = childrenOf(pPr).find((child) => nodeName(child) === 'w:pStyle');
  return style ? (attrsOf(style)['w:val'] ?? null) : null;
}

function isListParagraph(paragraph: XmlNode): boolean {
  const pPr = findFirst(childrenOf(paragraph), 'w:pPr');
  return pPr ? childrenOf(pPr).some((child) => nodeName(child) === 'w:numPr') : false;
}

function listLevel(paragraph: XmlNode): number {
  const pPr = findFirst(childrenOf(paragraph), 'w:pPr');
  const numPr = pPr ? findFirst(childrenOf(pPr), 'w:numPr') : null;
  const ilvl = numPr ? findFirst(childrenOf(numPr), 'w:ilvl') : null;
  return ilvl ? Number(attrsOf(ilvl)['w:val'] ?? '0') : 0;
}

function paragraphText(paragraph: XmlNode): string {
  return gatherText(childrenOf(paragraph), ['w:t'], ['w:br', 'w:tab'])
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function tableContent(table: XmlNode): { content: string; rows: number; columns: number } {
  const rows = childrenOf(table).filter((child) => nodeName(child) === 'w:tr');
  let columns = 0;
  const lines = rows
    .map((row) => {
      const cells = childrenOf(row)
        .filter((child) => nodeName(child) === 'w:tc')
        .map((cell) =>
          childrenOf(cell)
            .filter((child) => nodeName(child) === 'w:p')
            .map(paragraphText)
            .filter((text) => text.length > 0)
            .join(' ')
        );
      columns = Math.max(columns, cells.length);
      return cells.join(' | ');
    })
    .filter((line) => line.replace(/\|/g, '').trim().length > 0);
  return { content: lines.join('\n'), rows: lines.length, columns };
}

export async function extractDocx(bytes: Uint8Array): Promise<ExtractedSection[]> {
  const zip = await openOoxmlArchive(bytes, 'docx');
  const documentXml = await readArchiveXml(zip, 'word/document.xml', 'docx');
  const body = findFirst(documentXml, 'w:body');
  if (!body) {
    throw new ExtractionFailedError('malformed', 'docx: missing w:body');
  }

  const sections: ExtractedSection[] = [];
  let currentHeading: string | null = null;
  let pendingList: { lines: string[]; itemCount: number } | null = null;

  const flushList = () => {
    if (pendingList && pendingList.lines.length > 0) {
      sections.push({
        sectionType: 'list',
        sequence: sections.length,
        pageNumber: null,
        slideNumber: null,
        heading: currentHeading,
        content: pendingList.lines.join('\n'),
        metadata: { items: pendingList.itemCount },
      });
    }
    pendingList = null;
  };

  for (const child of childrenOf(body)) {
    const name = nodeName(child);

    if (name === 'w:tbl') {
      flushList();
      const table = tableContent(child);
      if (table.content.length > 0) {
        sections.push({
          sectionType: 'table',
          sequence: sections.length,
          pageNumber: null,
          slideNumber: null,
          heading: currentHeading,
          content: table.content,
          metadata: { rows: table.rows, columns: table.columns },
        });
      }
      continue;
    }

    if (name !== 'w:p') {
      continue; // sectPr and other non-content body elements
    }

    const text = paragraphText(child);
    if (text.length === 0) {
      continue;
    }

    const style = paragraphStyle(child);
    const headingMatch = style ? style.match(/^Heading([1-9])$/) : null;
    if (headingMatch || style === 'Title') {
      flushList();
      currentHeading = text;
      sections.push({
        sectionType: 'heading',
        sequence: sections.length,
        pageNumber: null,
        slideNumber: null,
        heading: null,
        content: text,
        metadata: { level: headingMatch ? Number(headingMatch[1]) : 0 },
      });
      continue;
    }

    if (isListParagraph(child)) {
      if (!pendingList) {
        pendingList = { lines: [], itemCount: 0 };
      }
      pendingList.lines.push(`${'  '.repeat(listLevel(child))}- ${text}`);
      pendingList.itemCount += 1;
      continue;
    }

    flushList();
    sections.push({
      sectionType: 'paragraph',
      sequence: sections.length,
      pageNumber: null,
      slideNumber: null,
      heading: currentHeading,
      content: text,
      metadata: null,
    });
  }
  flushList();

  return sections;
}
