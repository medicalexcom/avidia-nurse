import JSZip from 'jszip';

/**
 * Deterministic, legally safe test-fixture builders (spec S). Fixtures are
 * generated in memory from known strings — no binaries in the repository and
 * no copyrighted educational material. Used by ingestion and worker tests.
 */

function escapePdfText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Build a minimal, valid, uncompressed text PDF: one array of lines per page.
 * An empty lines array produces a blank page (no text operators).
 */
export function buildPdfFixture(pages: string[][]): Uint8Array {
  const objects: string[] = [];
  const pageCount = pages.length;
  const fontObjNumber = 3 + pageCount * 2;

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);

  pages.forEach((lines, i) => {
    const contentObjNumber = 4 + i * 2;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontObjNumber} 0 R >> >> ` +
        `/Contents ${contentObjNumber} 0 R >>`
    );
    const ops =
      lines.length === 0
        ? ''
        : `BT /F1 12 Tf 72 720 Td ${lines
            .map((line, li) => `${li === 0 ? '' : '0 -16 Td '}(${escapePdfText(line)}) Tj`)
            .join(' ')} ET`;
    objects.push(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
  });

  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i += 1) {
    bytes[i] = pdf.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface PptxSlideFixture {
  title?: string;
  /** Bullet lines as [text, outlineLevel]. */
  bullets?: [string, number][];
  table?: string[][];
  notes?: string;
}

/** Build a minimal PPTX with the given slides, in the given order. */
export async function buildPptxFixture(slides: PptxSlideFixture[]): Promise<Uint8Array> {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/></Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
      `</Relationships>`
  );

  const sldIds = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('');
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<p:sldIdLst>${sldIds}</p:sldIdLst></p:presentation>`
  );
  const presRels = slides
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" ` +
        `Target="slides/slide${i + 1}.xml"/>`
    )
    .join('');
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presRels}</Relationships>`
  );

  const run = (text: string) => `<a:r><a:t>${xmlEscape(text)}</a:t></a:r>`;

  slides.forEach((slide, i) => {
    const shapes: string[] = [];
    if (slide.title) {
      shapes.push(
        `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
          `<p:txBody><a:p>${run(slide.title)}</a:p></p:txBody></p:sp>`
      );
    }
    if (slide.bullets && slide.bullets.length > 0) {
      const paragraphs = slide.bullets
        .map(([text, level]) => `<a:p><a:pPr lvl="${level}"/>${run(text)}</a:p>`)
        .join('');
      shapes.push(
        `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>` +
          `<p:txBody>${paragraphs}</p:txBody></p:sp>`
      );
    }
    // A slide-number placeholder that must never appear in extracted content.
    shapes.push(
      `<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>` +
        `<p:txBody><a:p>${run(String(i + 1))}</a:p></p:txBody></p:sp>`
    );
    if (slide.table) {
      const rows = slide.table
        .map(
          (cells) =>
            `<a:tr>${cells
              .map((cell) => `<a:tc><a:txBody><a:p>${run(cell)}</a:p></a:txBody></a:tc>`)
              .join('')}</a:tr>`
        )
        .join('');
      shapes.push(
        `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${rows}</a:tbl>` +
          `</a:graphicData></a:graphic></p:graphicFrame>`
      );
    }
    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ` +
        `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
        `<p:cSld><p:spTree>${shapes.join('')}</p:spTree></p:cSld></p:sld>`
    );

    if (slide.notes) {
      zip.file(
        `ppt/slides/_rels/slide${i + 1}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" ` +
          `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" ` +
          `Target="../notesSlides/notesSlide${i + 1}.xml"/></Relationships>`
      );
      zip.file(
        `ppt/notesSlides/notesSlide${i + 1}.xml`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ` +
          `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
          `<p:cSld><p:spTree>` +
          `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>` +
          `<p:txBody><a:p>${run(slide.notes)}</a:p></p:txBody></p:sp>` +
          `<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>` +
          `<p:txBody><a:p>${run(String(i + 1))}</a:p></p:txBody></p:sp>` +
          `</p:spTree></p:cSld></p:notes>`
      );
    }
  });

  return zip.generateAsync({ type: 'uint8array' });
}

export type DocxBlockFixture =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'listItem'; level: number; text: string }
  | { kind: 'table'; rows: string[][] };

/** Build a minimal DOCX whose body contains the given blocks, in order. */
export async function buildDocxFixture(blocks: DocxBlockFixture[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/></Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`
  );

  const body = blocks
    .map((block) => {
      switch (block.kind) {
        case 'heading':
          return (
            `<w:p><w:pPr><w:pStyle w:val="Heading${block.level}"/></w:pPr>` +
            `<w:r><w:t>${xmlEscape(block.text)}</w:t></w:r></w:p>`
          );
        case 'listItem':
          return (
            `<w:p><w:pPr><w:numPr><w:ilvl w:val="${block.level}"/><w:numId w:val="1"/></w:numPr></w:pPr>` +
            `<w:r><w:t>${xmlEscape(block.text)}</w:t></w:r></w:p>`
          );
        case 'table': {
          const rows = block.rows
            .map(
              (cells) =>
                `<w:tr>${cells
                  .map((cell) => `<w:tc><w:p><w:r><w:t>${xmlEscape(cell)}</w:t></w:r></w:p></w:tc>`)
                  .join('')}</w:tr>`
            )
            .join('');
          return `<w:tbl>${rows}</w:tbl>`;
        }
        case 'paragraph':
        default:
          return `<w:p><w:r><w:t>${xmlEscape(block.text)}</w:t></w:r></w:p>`;
      }
    })
    .join('');

  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body>${body}<w:sectPr/></w:body></w:document>`
  );

  return zip.generateAsync({ type: 'uint8array' });
}
