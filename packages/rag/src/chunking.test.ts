import { ExtractedSection } from '@avidia/domain';

import {
  chunkSections,
  estimateTokens,
  splitTable,
  splitWithOverlap,
  CONCEPT_BOUNDARY_MARKERS,
  RELATIONSHIP_MARKERS,
} from './chunking';

function section(overrides: Partial<ExtractedSection>): ExtractedSection {
  return {
    sectionType: 'paragraph',
    sequence: 0,
    pageNumber: null,
    slideNumber: null,
    heading: null,
    content: 'content',
    metadata: null,
    ...overrides,
  };
}

describe('estimateTokens', () => {
  it('uses the chars/4 heuristic with a floor of 1', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(41))).toBe(11);
    expect(estimateTokens('')).toBe(1);
  });
});

describe('splitWithOverlap', () => {
  it('returns short text unchanged', () => {
    expect(splitWithOverlap('short text')).toEqual(['short text']);
  });

  it('splits at line boundaries and carries the previous last line as overlap', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i} ${'x'.repeat(20)}`);
    const text = lines.join('\n');
    const parts = splitWithOverlap(text, 120);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(120);
    }
    // Each later part begins with the final line of the previous part.
    for (let i = 1; i < parts.length; i += 1) {
      const prevLastLine = parts[i - 1]!.slice(parts[i - 1]!.lastIndexOf('\n') + 1);
      expect(parts[i]!.startsWith(prevLastLine)).toBe(true);
    }
    // No content lost: every original line appears somewhere.
    const joined = parts.join('\n');
    for (const line of lines) {
      expect(joined).toContain(line);
    }
  });

  it('hard-splits a single enormous token without boundaries', () => {
    const parts = splitWithOverlap('z'.repeat(500), 120);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toHaveLength(500);
  });

  it('respects concept boundary markers when splitting', () => {
    // Create text with a concept boundary marker near the end of the first chunk
    const beforeBoundary = 'Glucose Metabolism: The basic biochemical process...\n'.repeat(60);
    const boundaryMarker = `${CONCEPT_BOUNDARY_MARKERS[0]!}: `;
    const afterBoundary = 'DKA pathophysiology is complex.\n'.repeat(60);

    const text = beforeBoundary + boundaryMarker + afterBoundary;
    const parts = splitWithOverlap(text, 120, true); // Allow context bonus

    // Should create multiple parts due to concept boundary
    expect(parts.length).toBeGreaterThan(1);

    // The boundary marker should appear in the later parts, not split awkwardly
    const allParts = parts.join('\n');
    expect(allParts).toContain(boundaryMarker);
  });

  it('preserves relationship markers in chunks', () => {
    const textWithRelationship = `
      Hyperkalemia causes serious cardiac arrhythmias.
      This leads to sudden cardiac death if untreated.
      Therefore, potassium must be corrected urgently.
    `.repeat(100);

    const parts = splitWithOverlap(textWithRelationship);
    expect(parts.length).toBeGreaterThan(0);

    // All relationship markers should appear somewhere in the chunks
    for (const marker of ['leads to', 'Therefore']) {
      const found = parts.some((part) => part.includes(marker));
      expect(found).toBe(true);
    }
  });

  it('allows context bonus to exceed normal chunk size for concept preservation', () => {
    const textWithBoundary = 'Content '.repeat(500); // Very long text
    const partsWithBonus = splitWithOverlap(textWithBoundary, 120, true);
    const partsWithoutBonus = splitWithOverlap(textWithBoundary, 120, false);

    // With bonus, should have fewer or equal parts (larger chunks allowed)
    expect(partsWithBonus.length).toBeLessThanOrEqual(partsWithoutBonus.length);
  });
});

describe('splitTable', () => {
  it('repeats the header row in every part', () => {
    const header = 'Drug | Class | Antidote';
    const rows = Array.from({ length: 20 }, (_, i) => `drug${i} | class${i} | antidote${i}`);
    const parts = splitTable([header, ...rows].join('\n'), 200);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.startsWith(header)).toBe(true);
    }
    // Every data row appears exactly once across parts.
    const all = parts.join('\n');
    for (const row of rows) {
      expect(all.split(row).length - 1).toBe(1);
    }
  });

  it('returns small tables unchanged', () => {
    const table = 'a | b\n1 | 2';
    expect(splitTable(table)).toEqual([table]);
  });
});

describe('chunkSections — PPTX', () => {
  const sections: ExtractedSection[] = [
    section({
      sectionType: 'slide_title',
      sequence: 0,
      slideNumber: 1,
      heading: 'Pulmonary Embolism',
      content: 'Pulmonary Embolism',
    }),
    section({
      sectionType: 'slide_body',
      sequence: 1,
      slideNumber: 1,
      heading: 'Pulmonary Embolism',
      content: 'Sudden dyspnea, pleuritic chest pain, tachycardia.',
    }),
    section({
      sectionType: 'table',
      sequence: 2,
      slideNumber: 1,
      heading: 'Pulmonary Embolism',
      content: 'Sign | Meaning\nD-dimer | sensitive not specific',
    }),
    section({
      sectionType: 'slide_notes',
      sequence: 3,
      slideNumber: 1,
      heading: 'Pulmonary Embolism',
      content: 'Emphasize Virchow triad on the exam.',
    }),
    section({
      sectionType: 'slide_title',
      sequence: 4,
      slideNumber: 2,
      heading: 'COPD',
      content: 'COPD',
    }),
    section({
      sectionType: 'slide_body',
      sequence: 5,
      slideNumber: 2,
      heading: 'COPD',
      content: 'Decreased FEV1/FVC, elevated PaCO2.',
    }),
  ];

  it('builds one core chunk per slide plus table and notes chunks, in order', () => {
    const chunks = chunkSections(sections, 'pptx');
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2, 3]);

    const core = chunks[0]!;
    expect(core.content).toContain('Pulmonary Embolism');
    expect(core.content).toContain('Sudden dyspnea');
    expect(core.sourceLocator).toEqual({
      type: 'pptx',
      slide: 1,
      title: 'Pulmonary Embolism',
    });
    expect(core.sectionStart).toBe(0);
    expect(core.sectionEnd).toBe(1);

    const table = chunks[1]!;
    expect(table.sourceLocator.table).toBe(true);
    expect(table.sourceLocator.slide).toBe(1);
    // Table chunk carries the slide title for context.
    expect(table.content.startsWith('Pulmonary Embolism')).toBe(true);
    expect(table.content).toContain('D-dimer');

    const notes = chunks[2]!;
    expect(notes.sourceLocator.notes).toBe(true);
    expect(notes.content).toContain('Virchow');

    const slide2 = chunks[3]!;
    expect(slide2.sourceLocator).toEqual({ type: 'pptx', slide: 2, title: 'COPD' });
  });

  it('includes semantic context for slides with relationship chains', () => {
    const semanticSections: ExtractedSection[] = [
      section({
        sectionType: 'slide_title',
        sequence: 0,
        slideNumber: 1,
        heading: 'DKA Pathophysiology',
        content: 'Diabetic Ketoacidosis',
      }),
      section({
        sectionType: 'slide_body',
        sequence: 1,
        slideNumber: 1,
        heading: 'DKA Pathophysiology',
        content: `Glucose Metabolism leads to insulin deficiency, which causes hyperglycemia.
                  This results in osmotic diuresis. Therefore, severe dehydration occurs.
                  As a result, electrolyte imbalances develop.`,
      }),
    ];

    const chunks = chunkSections(semanticSections, 'pptx');
    expect(chunks.length).toBeGreaterThan(0);

    // Should have semantic context tracking relationship chains
    const firstChunk = chunks[0]!;
    expect(firstChunk.semanticContext).toBeDefined();
    expect(firstChunk.semanticContext?.hasRelationshipChain).toBe(true);
    expect(firstChunk.semanticContext?.containsConceptTerms).toBeDefined();
    expect(firstChunk.semanticContext?.containsConceptTerms).toContain('Glucose Metabolism');
  });
});

describe('chunkSections — PDF', () => {
  it('builds one chunk per page with page provenance', () => {
    const chunks = chunkSections(
      [
        section({ sectionType: 'page_text', sequence: 0, pageNumber: 1, content: 'Page one.' }),
        section({ sectionType: 'page_text', sequence: 1, pageNumber: 2, content: 'Page two.' }),
      ],
      'pdf'
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.sourceLocator).toEqual({ type: 'pdf', page: 1 });
    expect(chunks[1]!.sourceLocator).toEqual({ type: 'pdf', page: 2 });
  });

  it('splits an oversized page into parts with part numbers', () => {
    const big = Array.from({ length: 200 }, (_, i) => `Sentence ${i} about heart failure.`).join(
      '\n'
    );
    const chunks = chunkSections(
      [section({ sectionType: 'page_text', sequence: 0, pageNumber: 3, content: big })],
      'pdf'
    );
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk, index) => {
      expect(chunk.sourceLocator.page).toBe(3);
      expect(chunk.sourceLocator.part).toBe(index + 1);
      expect(chunk.content.length).toBeLessThanOrEqual(1920);
    });
  });

  it('regroups multiple page_text sections of the same page', () => {
    const chunks = chunkSections(
      [
        section({ sectionType: 'page_text', sequence: 0, pageNumber: 1, content: 'First half.' }),
        section({ sectionType: 'page_text', sequence: 1, pageNumber: 1, content: 'Second half.' }),
      ],
      'pdf'
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe('First half.\nSecond half.');
    expect(chunks[0]!.sectionStart).toBe(0);
    expect(chunks[0]!.sectionEnd).toBe(1);
  });

  it('preserves semantic context for PDF chunks with complex content', () => {
    const complexContent = `
      Pathophysiology of Acute Kidney Injury:
      
      Acute kidney injury causes rapid decline in glomerular filtration.
      This leads to accumulation of nitrogenous waste.
      Therefore, hyperkalemia develops. As a result, cardiac arrhythmias may occur.
      
      Clinical manifestations and management strategies.
    `;

    const chunks = chunkSections(
      [section({ sectionType: 'page_text', sequence: 0, pageNumber: 1, content: complexContent })],
      'pdf'
    );

    expect(chunks.length).toBeGreaterThan(0);
    const firstChunk = chunks[0]!;
    expect(firstChunk.semanticContext).toBeDefined();
    expect(firstChunk.semanticContext?.hasRelationshipChain).toBe(true);
  });
});

describe('chunkSections — DOCX/TXT heading flow', () => {
  it('groups a heading with its following paragraphs and lists', () => {
    const chunks = chunkSections(
      [
        section({ sectionType: 'heading', sequence: 0, content: 'Diabetic Ketoacidosis' }),
        section({ sectionType: 'paragraph', sequence: 1, content: 'Hyperglycemia and ketones.' }),
        section({ sectionType: 'list', sequence: 2, content: '- fluids first\n- insulin drip' }),
        section({ sectionType: 'heading', sequence: 3, content: 'HHS' }),
        section({ sectionType: 'paragraph', sequence: 4, content: 'Higher glucose, no ketones.' }),
      ],
      'docx'
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.content).toContain('Diabetic Ketoacidosis');
    expect(chunks[0]!.content).toContain('insulin drip');
    expect(chunks[0]!.sourceLocator).toEqual({
      type: 'docx',
      sectionIndex: 0,
      heading: 'Diabetic Ketoacidosis',
    });
    expect(chunks[0]!.sectionStart).toBe(0);
    expect(chunks[0]!.sectionEnd).toBe(2);
    expect(chunks[1]!.sourceLocator.heading).toBe('HHS');
  });

  it('gives tables their own chunk with the heading prefixed', () => {
    const chunks = chunkSections(
      [
        section({ sectionType: 'heading', sequence: 0, content: 'Electrolytes' }),
        section({ sectionType: 'paragraph', sequence: 1, content: 'Ranges below.' }),
        section({
          sectionType: 'table',
          sequence: 2,
          content: 'Electrolyte | Range\nK+ | 3.5-5.0',
        }),
      ],
      'docx'
    );
    expect(chunks).toHaveLength(2);
    const table = chunks[1]!;
    expect(table.sourceLocator.table).toBe(true);
    expect(table.sourceLocator.heading).toBe('Electrolytes');
    expect(table.content.startsWith('Electrolytes')).toBe(true);
  });

  it('flushes a group when it exceeds the size budget', () => {
    const para = 'A '.repeat(400).trim(); // ~800 chars
    const chunks = chunkSections(
      [
        section({ sectionType: 'heading', sequence: 0, content: 'Big Section' }),
        section({ sectionType: 'paragraph', sequence: 1, content: para }),
        section({ sectionType: 'paragraph', sequence: 2, content: para }),
        section({ sectionType: 'paragraph', sequence: 3, content: para }),
      ],
      'txt'
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(600);
    }
  });

  it('handles TXT paragraphs with no headings', () => {
    const chunks = chunkSections(
      [
        section({ sectionType: 'paragraph', sequence: 0, content: 'Plain paragraph one.' }),
        section({ sectionType: 'paragraph', sequence: 1, content: 'Plain paragraph two.' }),
      ],
      'txt'
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.sourceLocator).toEqual({ type: 'txt', sectionIndex: 0 });
  });

  it('respects concept boundary markers in heading flow', () => {
    const chunks = chunkSections(
      [
        section({ sectionType: 'heading', sequence: 0, content: 'Foundation: Glucose Metabolism' }),
        section({
          sectionType: 'paragraph',
          sequence: 1,
          content: 'Glucose is metabolized via glycolysis and oxidative phosphorylation.',
        }),
        section({
          sectionType: 'heading',
          sequence: 2,
          content: `${CONCEPT_BOUNDARY_MARKERS[0]!} Diabetic Ketoacidosis`,
        }),
        section({
          sectionType: 'paragraph',
          sequence: 3,
          content: 'DKA occurs when insulin is deficient or ineffective.',
        }),
      ],
      'docx'
    );

    // Should split when boundary marker is encountered in heading
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.sourceLocator.heading).toContain('Foundation');
  });
});

describe('chunkSections — semantic context extraction', () => {
  it('extracts concept terms from chunk content', () => {
    const chunks = chunkSections(
      [
        section({
          sectionType: 'page_text',
          sequence: 0,
          pageNumber: 1,
          content: `
            Diabetic Ketoacidosis and Hyperglycemia are serious Metabolic Disorders.
            Pathophysiology involves Insulin Deficiency and Ketone Production.
            Clinical Assessment requires Laboratory Testing and vital sign monitoring.
          `,
        }),
      ],
      'pdf'
    );

    expect(chunks.length).toBeGreaterThan(0);
    const chunk = chunks[0]!;
    expect(chunk.semanticContext?.containsConceptTerms).toBeDefined();

    // Should contain capitalized concept terms
    const terms = chunk.semanticContext?.containsConceptTerms || [];
    const foundConcepts = terms.filter((t) =>
      ['Diabetic', 'Ketoacidosis', 'Hyperglycemia', 'Metabolic', 'Disorder'].includes(t)
    );
    expect(foundConcepts.length).toBeGreaterThan(0);
  });

  it('identifies relationship chains in content', () => {
    const relationshipContent = `
      Hyperkalemia causes serious cardiac effects.
      This leads to life-threatening arrhythmias.
      Therefore, urgent potassium correction is necessary.
      As a result, ECG monitoring is required.
    `;

    const chunks = chunkSections(
      [
        section({
          sectionType: 'page_text',
          sequence: 0,
          pageNumber: 1,
          content: relationshipContent,
        }),
      ],
      'pdf'
    );

    expect(chunks.length).toBeGreaterThan(0);
    const chunk = chunks[0]!;
    expect(chunk.semanticContext?.hasRelationshipChain).toBe(true);
  });

  it('tracks part indices for split chunks', () => {
    const largeContent = 'Content line here.\n'.repeat(300);
    const chunks = chunkSections(
      [
        section({
          sectionType: 'page_text',
          sequence: 0,
          pageNumber: 1,
          content: largeContent,
        }),
      ],
      'pdf'
    );

    // Should have multiple parts
    expect(chunks.length).toBeGreaterThan(1);

    // Each part should track its index and total parts
    chunks.forEach((chunk, index) => {
      expect(chunk.semanticContext?.partIndex).toBe(index);
      expect(chunk.semanticContext?.totalParts).toBe(chunks.length);
    });
  });
});

describe('chunkSections — determinism and hygiene', () => {
  it('is deterministic and sorts unordered input by sequence', () => {
    const sections = [
      section({ sectionType: 'page_text', sequence: 1, pageNumber: 2, content: 'Second.' }),
      section({ sectionType: 'page_text', sequence: 0, pageNumber: 1, content: 'First.' }),
    ];
    const a = chunkSections(sections, 'pdf');
    const b = chunkSections(sections, 'pdf');
    expect(a).toEqual(b);
    expect(a[0]!.content).toBe('First.');
  });

  it('skips empty content and returns no chunks for empty input', () => {
    expect(chunkSections([], 'pdf')).toEqual([]);
    expect(
      chunkSections(
        [section({ sectionType: 'page_text', sequence: 0, pageNumber: 1, content: '   ' })],
        'pdf'
      )
    ).toEqual([]);
  });

  it('preserves semantic context across deterministic re-chunking', () => {
    const sections = [
      section({
        sectionType: 'page_text',
        sequence: 0,
        pageNumber: 1,
        content: `
          Glucose Metabolism leads to Insulin Secretion.
          This results in glucose uptake. Therefore, blood glucose decreases.
        `,
      }),
    ];

    const a = chunkSections(sections, 'pdf');
    const b = chunkSections(sections, 'pdf');

    // Semantic context should be identical on re-chunking
    expect(a[0]!.semanticContext).toEqual(b[0]!.semanticContext);
  });
});

describe('Concept boundary and relationship marker constants', () => {
  it('provides meaningful concept boundary markers', () => {
    expect(CONCEPT_BOUNDARY_MARKERS.length).toBeGreaterThan(0);
    expect(CONCEPT_BOUNDARY_MARKERS).toContain('prerequisite:');
    expect(CONCEPT_BOUNDARY_MARKERS).toContain('causes of');
  });

  it('provides meaningful relationship markers', () => {
    expect(RELATIONSHIP_MARKERS.length).toBeGreaterThan(0);
    expect(RELATIONSHIP_MARKERS).toContain('leads to');
    expect(RELATIONSHIP_MARKERS).toContain('therefore');
  });

  it('has non-overlapping marker sets', () => {
    const allMarkers = new Set([...CONCEPT_BOUNDARY_MARKERS, ...RELATIONSHIP_MARKERS]);
    expect(allMarkers.size).toBe(
      CONCEPT_BOUNDARY_MARKERS.length + RELATIONSHIP_MARKERS.length
    );
  });
});
