import {
  describeSectionSource,
  ExtractedSection,
  MAX_SECTION_CONTENT_CHARS,
  validateSectionBatch,
} from './sections';

function section(overrides: Partial<ExtractedSection> = {}): ExtractedSection {
  return {
    sectionType: 'paragraph',
    sequence: 0,
    pageNumber: null,
    slideNumber: null,
    heading: null,
    content: 'Assess airway, breathing and circulation first.',
    metadata: null,
    ...overrides,
  };
}

describe('describeSectionSource', () => {
  it('prefers slide, then page, then heading, then a generic locator', () => {
    expect(describeSectionSource({ slideNumber: 21, pageNumber: null, heading: null })).toBe(
      'slide 21'
    );
    expect(describeSectionSource({ slideNumber: null, pageNumber: 8, heading: 'Renal' })).toBe(
      'page 8'
    );
    expect(
      describeSectionSource({
        slideNumber: null,
        pageNumber: null,
        heading: 'Postoperative Complications',
      })
    ).toBe('section \u201cPostoperative Complications\u201d');
    expect(describeSectionSource({ slideNumber: null, pageNumber: null, heading: null })).toBe(
      'document'
    );
  });
});

describe('validateSectionBatch', () => {
  it('accepts a well-formed ordered batch', () => {
    const batch = [
      section({ sectionType: 'heading', sequence: 0, content: 'Fluid Balance' }),
      section({ sequence: 1, heading: 'Fluid Balance' }),
      section({ sectionType: 'table', sequence: 2, content: 'Na | 135–145' }),
    ];
    expect(validateSectionBatch(batch)).toEqual([]);
  });

  it('rejects sequence gaps, empty content, and oversize content', () => {
    const problems = validateSectionBatch([
      section({ sequence: 1 }),
      section({ sequence: 1, content: '   ' }),
      section({ sequence: 2, content: 'x'.repeat(MAX_SECTION_CONTENT_CHARS + 1) }),
    ]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('breaks reading order');
    expect(problems[1]).toContain('empty content');
    expect(problems[2]).toContain('exceeds');
  });

  it('accepts an empty batch (the caller decides whether zero sections is a failure)', () => {
    expect(validateSectionBatch([])).toEqual([]);
  });
});
