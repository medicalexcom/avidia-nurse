import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

import { ExtractionFailedError } from './types';

/**
 * Shared OOXML plumbing for PPTX and DOCX: both formats are ZIP archives of
 * XML parts. Parsing preserves document order (preserveOrder), which is what
 * makes reading-order extraction possible. Only declared text nodes (w:t,
 * a:t) are ever read as content — coordinates, themes and other technical
 * XML never leak into the extracted text.
 */

/** One node of fast-xml-parser's preserveOrder output. */
export type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

export function parseXml(xml: string): XmlNode[] {
  return parser.parse(xml) as XmlNode[];
}

/** The element name of an ordered node (ignoring the ':@' attribute bag). */
export function nodeName(node: XmlNode): string | null {
  for (const key of Object.keys(node)) {
    if (key !== ':@') {
      return key;
    }
  }
  return null;
}

export function childrenOf(node: XmlNode): XmlNode[] {
  const name = nodeName(node);
  if (!name) {
    return [];
  }
  const value = node[name];
  return Array.isArray(value) ? (value as XmlNode[]) : [];
}

export function attrsOf(node: XmlNode): Record<string, string> {
  const bag = node[':@'];
  if (!bag || typeof bag !== 'object') {
    return {};
  }
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(bag as Record<string, unknown>)) {
    if (key.startsWith('@_')) {
      attrs[key.slice(2)] = String(value);
    }
  }
  return attrs;
}

/** Depth-first search for the first descendant with the given element name. */
export function findFirst(nodes: XmlNode[], name: string): XmlNode | null {
  for (const node of nodes) {
    if (nodeName(node) === name) {
      return node;
    }
    const found = findFirst(childrenOf(node), name);
    if (found) {
      return found;
    }
  }
  return null;
}

/** Depth-first collection of all descendants with the given element name. */
export function findAll(nodes: XmlNode[], name: string): XmlNode[] {
  const matches: XmlNode[] = [];
  for (const node of nodes) {
    if (nodeName(node) === name) {
      matches.push(node);
    }
    matches.push(...findAll(childrenOf(node), name));
  }
  return matches;
}

/**
 * Concatenate the text carried by the given text-element names beneath a
 * node, in document order. `breakNames` (e.g. a:br, w:br) become newlines and
 * w:tab becomes a tab so words never fuse together.
 */
export function gatherText(
  nodes: XmlNode[],
  textNames: readonly string[],
  breakNames: readonly string[] = []
): string {
  let out = '';
  for (const node of nodes) {
    const name = nodeName(node);
    if (name === '#text') {
      continue; // stray whitespace between elements, not run text
    }
    if (name && breakNames.includes(name)) {
      out += name === 'w:tab' ? '\t' : '\n';
      continue;
    }
    if (name && textNames.includes(name)) {
      for (const child of childrenOf(node)) {
        const text = child['#text'];
        if (typeof text === 'string' || typeof text === 'number') {
          out += String(text);
        }
      }
      continue;
    }
    out += gatherText(childrenOf(node), textNames, breakNames);
  }
  return out;
}

/** Open an OOXML archive, mapping ZIP-level corruption to `malformed`. */
export async function openOoxmlArchive(bytes: Uint8Array, label: string): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(bytes);
  } catch (error) {
    const name = error instanceof Error ? error.message.slice(0, 120) : 'unknown';
    throw new ExtractionFailedError('malformed', `${label}: not a readable archive (${name})`);
  }
}

/** Read a required XML part from the archive, or fail as `malformed`. */
export async function readArchiveXml(zip: JSZip, path: string, label: string): Promise<XmlNode[]> {
  const file = zip.file(path);
  if (!file) {
    throw new ExtractionFailedError('malformed', `${label}: missing part ${path}`);
  }
  const xml = await file.async('string');
  try {
    return parseXml(xml);
  } catch {
    throw new ExtractionFailedError('malformed', `${label}: unparseable XML in ${path}`);
  }
}
