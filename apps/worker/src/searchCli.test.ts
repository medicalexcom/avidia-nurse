import { parseSearchArgs } from './searchCli';
import { toVectorLiteral } from './supabaseIndexerClient';

describe('parseSearchArgs', () => {
  it('parses required and optional flags', () => {
    const args = parseSearchArgs([
      'node',
      'index.ts',
      '--search',
      '--course',
      'course-1',
      '--query',
      'DKA priority action',
      '--document',
      'doc-9',
      '--top-k',
      '5',
      '--min-similarity',
      '0.25',
    ]);
    expect(args).toEqual({
      courseId: 'course-1',
      query: 'DKA priority action',
      documentId: 'doc-9',
      topK: 5,
      minSimilarity: 0.25,
    });
  });

  it('defaults topK, threshold, and document filter', () => {
    const args = parseSearchArgs(['--course', 'c', '--query', 'q']);
    expect(args).toEqual({
      courseId: 'c',
      query: 'q',
      documentId: null,
      topK: 8,
      minSimilarity: 0,
    });
  });

  it('rejects missing course or query with usage help', () => {
    expect(() => parseSearchArgs(['--course', 'c'])).toThrow('Usage:');
    expect(() => parseSearchArgs(['--query', 'q'])).toThrow('Usage:');
  });
});

describe('toVectorLiteral', () => {
  it('serializes to the pgvector text form', () => {
    expect(toVectorLiteral([0.5, -1, 2])).toBe('[0.5,-1,2]');
    expect(toVectorLiteral([])).toBe('[]');
  });
});
