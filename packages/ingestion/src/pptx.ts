import { ExtractedSection } from '@avidia/domain';

import {
  attrsOf,
  childrenOf,
  findAll,
  findFirst,
  gatherText,
  nodeName,
  openOoxmlArchive,
  readArchiveXml,
  XmlNode,
} from './ooxml';
import { normalizeExtractedText } from './text';
import { ExtractionFailedError } from './types';

/**
 * PPTX extraction (spec C): slide order from p:sldIdLst (the authoritative
 * presentation order, not file names), slide titles from title placeholders,
 * body text with bullet indentation, tables, and speaker notes. Every section
 * carries its slide number so provenance can say "Lecture 4 → slide 21".
 */

const TITLE_PLACEHOLDER_TYPES = new Set(['title', 'ctrTitle']);
/** Placeholders that are chrome, not educational content. */
const IGNORED_PLACEHOLDER_TYPES = new Set(['sldNum', 'ftr', 'dt', 'hdr']);

function placeholderType(shape: XmlNode): string | null {
  const ph = findFirst(childrenOf(shape), 'p:ph');
  return ph ? (attrsOf(ph).type ?? 'body') : null;
}

/** Text of one a:p paragraph, with "- " bullets indented by outline level. */
function paragraphLine(paragraph: XmlNode, bullet: boolean): string {
  const pPr = findFirst(childrenOf(paragraph), 'a:pPr');
  const level = pPr ? Number(attrsOf(pPr).lvl ?? '0') : 0;
  const text = gatherText(childrenOf(paragraph), ['a:t'], ['a:br']).replace(/\s+/g, ' ').trim();
  if (text.length === 0) {
    return '';
  }
  return bullet ? `${'  '.repeat(level)}- ${text}` : text;
}

function shapeText(shape: XmlNode, bullet: boolean): string {
  const txBody = findFirst(childrenOf(shape), 'p:txBody');
  if (!txBody) {
    return '';
  }
  const lines = childrenOf(txBody)
    .filter((child) => nodeName(child) === 'a:p')
    .map((p) => paragraphLine(p, bullet))
    .filter((line) => line.length > 0);
  return lines.join('\n');
}

function tableText(graphicFrame: XmlNode): { content: string; rows: number; columns: number } {
  const tbl = findFirst(childrenOf(graphicFrame), 'a:tbl');
  if (!tbl) {
    return { content: '', rows: 0, columns: 0 };
  }
  const rows = childrenOf(tbl).filter((child) => nodeName(child) === 'a:tr');
  let columns = 0;
  const lines = rows
    .map((row) => {
      const cells = childrenOf(row)
        .filter((child) => nodeName(child) === 'a:tc')
        .map((cell) => gatherText(childrenOf(cell), ['a:t'], ['a:br']).replace(/\s+/g, ' ').trim());
      columns = Math.max(columns, cells.length);
      return cells.join(' | ');
    })
    .filter((line) => line.replace(/\|/g, '').trim().length > 0);
  return { content: lines.join('\n'), rows: lines.length, columns };
}

/** Recursively walk a shape tree (handles grouped shapes). */
function walkShapes(nodes: XmlNode[], visit: (node: XmlNode, name: string) => void): void {
  for (const node of nodes) {
    const name = nodeName(node);
    if (name === 'p:sp' || name === 'p:graphicFrame') {
      visit(node, name);
    } else if (name === 'p:grpSp') {
      walkShapes(childrenOf(node), visit);
    }
  }
}

interface SlideRef {
  slideNumber: number;
  path: string;
}

/** Resolve slide order: p:sldIdLst r:id order joined to the rels targets. */
async function orderedSlides(
  zip: Awaited<ReturnType<typeof openOoxmlArchive>>
): Promise<SlideRef[]> {
  const rels = await readArchiveXml(zip, 'ppt/_rels/presentation.xml.rels', 'pptx');
  const relTargets = new Map<string, string>();
  for (const rel of findAll(rels, 'Relationship')) {
    const attrs = attrsOf(rel);
    if (attrs.Id && attrs.Target) {
      relTargets.set(attrs.Id, attrs.Target.replace(/^\//, ''));
    }
  }

  const presentation = await readArchiveXml(zip, 'ppt/presentation.xml', 'pptx');
  const slideIds = findAll(presentation, 'p:sldId');
  const slides: SlideRef[] = [];
  for (const slideId of slideIds) {
    const rid = attrsOf(slideId)['r:id'];
    const target = rid ? relTargets.get(rid) : undefined;
    if (target) {
      slides.push({ slideNumber: slides.length + 1, path: `ppt/${target}` });
    }
  }
  return slides;
}

/** Speaker notes for a slide, if a notesSlide relationship exists. */
async function slideNotes(
  zip: Awaited<ReturnType<typeof openOoxmlArchive>>,
  slidePath: string
): Promise<string> {
  const slideFile = slidePath.split('/').pop() ?? '';
  const relsPath = `ppt/slides/_rels/${slideFile}.rels`;
  if (!zip.file(relsPath)) {
    return '';
  }
  const rels = await readArchiveXml(zip, relsPath, 'pptx');
  const notesRel = findAll(rels, 'Relationship').find((rel) =>
    (attrsOf(rel).Type ?? '').endsWith('/notesSlide')
  );
  if (!notesRel) {
    return '';
  }
  const target = (attrsOf(notesRel).Target ?? '').replace(/^\.\.\//, 'ppt/');
  if (target.length === 0 || !zip.file(target)) {
    return '';
  }
  const notes = await readArchiveXml(zip, target, 'pptx');
  const lines: string[] = [];
  walkShapes(childrenOf(findFirst(notes, 'p:spTree') ?? {}), (node, name) => {
    if (name !== 'p:sp') {
      return;
    }
    // The notes text lives in the 'body' placeholder; slide-number and
    // slide-image placeholders are chrome.
    const type = placeholderType(node);
    if (type === 'body' || type === null) {
      const text = shapeText(node, false);
      if (text.length > 0) {
        lines.push(text);
      }
    }
  });
  return normalizeExtractedText(lines.join('\n'));
}

export async function extractPptx(bytes: Uint8Array): Promise<ExtractedSection[]> {
  const zip = await openOoxmlArchive(bytes, 'pptx');
  const slides = await orderedSlides(zip);
  if (slides.length === 0) {
    throw new ExtractionFailedError('malformed', 'pptx: no slides in presentation.xml');
  }

  const sections: ExtractedSection[] = [];
  for (const slide of slides) {
    const slideXml = await readArchiveXml(zip, slide.path, 'pptx');
    const spTree = findFirst(slideXml, 'p:spTree');
    if (!spTree) {
      continue;
    }

    let title: string | null = null;
    const bodies: string[] = [];
    const tables: { content: string; rows: number; columns: number }[] = [];

    walkShapes(childrenOf(spTree), (node, name) => {
      if (name === 'p:graphicFrame') {
        const table = tableText(node);
        if (table.content.length > 0) {
          tables.push(table);
        }
        return;
      }
      const type = placeholderType(node);
      if (type && IGNORED_PLACEHOLDER_TYPES.has(type)) {
        return;
      }
      if (type && TITLE_PLACEHOLDER_TYPES.has(type)) {
        const text = shapeText(node, false).replace(/\s+/g, ' ').trim();
        if (text.length > 0 && title === null) {
          title = text;
        }
        return;
      }
      // Body placeholders and meaningful free text boxes. Lines are already
      // clean (paragraphLine collapses whitespace); the general normalizer is
      // not applied here because it would strip bullet indentation.
      const text = shapeText(node, true);
      if (text.length > 0) {
        bodies.push(text);
      }
    });

    if (title !== null) {
      sections.push({
        sectionType: 'slide_title',
        sequence: sections.length,
        pageNumber: null,
        slideNumber: slide.slideNumber,
        heading: null,
        content: title,
        metadata: null,
      });
    }
    if (bodies.length > 0) {
      sections.push({
        sectionType: 'slide_body',
        sequence: sections.length,
        pageNumber: null,
        slideNumber: slide.slideNumber,
        heading: title,
        content: bodies.join('\n'),
        metadata: null,
      });
    }
    for (const table of tables) {
      sections.push({
        sectionType: 'table',
        sequence: sections.length,
        pageNumber: null,
        slideNumber: slide.slideNumber,
        heading: title,
        content: table.content,
        metadata: { rows: table.rows, columns: table.columns },
      });
    }
    const notes = await slideNotes(zip, slide.path);
    if (notes.length > 0) {
      sections.push({
        sectionType: 'slide_notes',
        sequence: sections.length,
        pageNumber: null,
        slideNumber: slide.slideNumber,
        heading: title,
        content: notes,
        metadata: null,
      });
    }
  }
  return sections;
}
