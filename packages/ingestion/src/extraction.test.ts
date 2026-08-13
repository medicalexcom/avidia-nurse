import { extractDocument, ExtractionFailedError } from './index';
import { buildDocxFixture, buildPdfFixture, buildPptxFixture } from './fixtures';

async function expectFailure(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`expected extraction to fail with ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ExtractionFailedError);
    expect((error as ExtractionFailedError).code).toBe(code);
  }
}

describe('PDF extraction', () => {
  it('extracts multiple pages with page provenance and ordering', async () => {
    const pdf = buildPdfFixture([
      ['Fluid and Electrolyte Basics', 'Sodium normal range 135 to 145.'],
      ['Potassium normal range 3.5 to 5.0.', 'Monitor cardiac rhythm closely.'],
      ['Calcium and magnesium follow renal status.'],
    ]);
    const { sections } = await extractDocument(pdf, 'pdf');

    expect(sections).toHaveLength(3);
    expect(sections.map((s) => s.pageNumber)).toEqual([1, 2, 3]);
    expect(sections.map((s) => s.sequence)).toEqual([0, 1, 2]);
    expect(sections.every((s) => s.sectionType === 'page_text')).toBe(true);
    expect(sections[0]!.content).toContain('Fluid and Electrolyte Basics');
    expect(sections[0]!.content).toContain('135 to 145');
    expect(sections[1]!.content).toContain('Monitor cardiac rhythm');
    expect(sections[2]!.content).toContain('renal status');
    // Not flattened: page 2 text is not attributed to page 1.
    expect(sections[0]!.content).not.toContain('Potassium');
  });

  it('reports a text-free PDF as requiring OCR instead of marking it ready', async () => {
    const scanned = buildPdfFixture([[], []]);
    await expectFailure(extractDocument(scanned, 'pdf'), 'ocr_required');
  });

  it('rejects a malformed PDF', async () => {
    const garbage = new TextEncoder().encode('this is not a pdf at all');
    await expectFailure(extractDocument(garbage, 'pdf'), 'malformed');
  });
});

describe('PPTX extraction', () => {
  it('extracts titles, bullet hierarchy, tables, and notes in slide order', async () => {
    const pptx = await buildPptxFixture([
      {
        title: 'Postoperative Complications',
        bullets: [
          ['Airway first', 0],
          ['Assess breathing pattern', 1],
        ],
        notes: 'Emphasize airway assessment on the exam.',
      },
      {
        title: 'Common Lab Values',
        table: [
          ['Test', 'Range'],
          ['Sodium', '135-145'],
        ],
      },
      { title: 'Questions', bullets: [['Review case studies', 0]] },
    ]);
    const { sections } = await extractDocument(pptx, 'pptx');

    const titles = sections.filter((s) => s.sectionType === 'slide_title');
    expect(titles.map((s) => s.content)).toEqual([
      'Postoperative Complications',
      'Common Lab Values',
      'Questions',
    ]);
    expect(titles.map((s) => s.slideNumber)).toEqual([1, 2, 3]);

    const body = sections.find((s) => s.sectionType === 'slide_body' && s.slideNumber === 1);
    expect(body?.content).toBe('- Airway first\n  - Assess breathing pattern');
    expect(body?.heading).toBe('Postoperative Complications');

    const table = sections.find((s) => s.sectionType === 'table');
    expect(table?.slideNumber).toBe(2);
    expect(table?.content).toBe('Test | Range\nSodium | 135-145');
    expect(table?.metadata).toEqual({ rows: 2, columns: 2 });

    const notes = sections.find((s) => s.sectionType === 'slide_notes');
    expect(notes?.slideNumber).toBe(1);
    expect(notes?.content).toBe('Emphasize airway assessment on the exam.');

    // Reading order is global and gapless.
    expect(sections.map((s) => s.sequence)).toEqual(sections.map((_, i) => i));
    // Slide-number placeholder chrome is not educational content.
    expect(sections.some((s) => /^[0-9]+$/.test(s.content))).toBe(false);
  });

  it('rejects an archive that is not a presentation', async () => {
    const garbage = new TextEncoder().encode('PK but not really');
    await expectFailure(extractDocument(garbage, 'pptx'), 'malformed');
  });
});

describe('DOCX extraction', () => {
  it('extracts headings, paragraphs, lists, and tables in document order', async () => {
    const docx = await buildDocxFixture([
      { kind: 'heading', level: 1, text: 'Renal Function' },
      { kind: 'paragraph', text: 'The kidneys regulate fluid and electrolyte balance.' },
      { kind: 'listItem', level: 0, text: 'Monitor intake and output' },
      { kind: 'listItem', level: 1, text: 'Report oliguria promptly' },
      { kind: 'heading', level: 2, text: 'Key Labs' },
      {
        kind: 'table',
        rows: [
          ['Lab', 'Range'],
          ['Creatinine', '0.6-1.2'],
        ],
      },
      { kind: 'paragraph', text: 'Trend results over time.' },
    ]);
    const { sections } = await extractDocument(docx, 'docx');

    expect(sections.map((s) => s.sectionType)).toEqual([
      'heading',
      'paragraph',
      'list',
      'heading',
      'table',
      'paragraph',
    ]);
    expect(sections[0]!.content).toBe('Renal Function');
    expect(sections[0]!.metadata).toEqual({ level: 1 });
    expect(sections[1]!.heading).toBe('Renal Function');
    expect(sections[2]!.content).toBe('- Monitor intake and output\n  - Report oliguria promptly');
    expect(sections[2]!.metadata).toEqual({ items: 2 });
    expect(sections[4]!.content).toBe('Lab | Range\nCreatinine | 0.6-1.2');
    expect(sections[4]!.heading).toBe('Key Labs');
    expect(sections[5]!.heading).toBe('Key Labs');
    expect(sections.map((s) => s.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('rejects a corrupted DOCX', async () => {
    await expectFailure(
      extractDocument(new TextEncoder().encode('not a zip'), 'docx'),
      'malformed'
    );
  });
});

describe('TXT extraction', () => {
  it('normalizes paragraphs, preserves order, and detects conservative headings', async () => {
    const txt = new TextEncoder().encode(
      'CARDIAC MEDICATIONS\r\n\r\nBeta blockers reduce heart rate\tand workload.\r\n\r\n' +
        '# Nursing considerations\r\n\r\nHold if heart rate is below sixty.\r\n\r\n\r\n' +
        'Document apical pulse before giving.'
    );
    const { sections } = await extractDocument(txt, 'txt');

    expect(sections.map((s) => s.sectionType)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'paragraph',
      'paragraph',
    ]);
    expect(sections[0]!.content).toBe('CARDIAC MEDICATIONS');
    expect(sections[1]!.content).toBe('Beta blockers reduce heart rate and workload.');
    expect(sections[1]!.heading).toBe('CARDIAC MEDICATIONS');
    expect(sections[2]!.content).toBe('Nursing considerations');
    expect(sections[3]!.heading).toBe('Nursing considerations');
    expect(sections[4]!.content).toBe('Document apical pulse before giving.');
  });

  it('does not invent headings from ordinary sentences', async () => {
    const txt = new TextEncoder().encode('Short line\n\nAnother ordinary sentence here.');
    const { sections } = await extractDocument(txt, 'txt');
    expect(sections.every((s) => s.sectionType === 'paragraph')).toBe(true);
  });

  it('fails with no_text for an empty file', async () => {
    await expectFailure(extractDocument(new Uint8Array(0), 'txt'), 'no_text');
  });
});
