import { computeQuestionFingerprint } from './fingerprint';

const metadata = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  promptVersion: 'p1',
  generationVersion: 'v1',
};

const chunks = [
  { id: 'c1', content: 'Hyperkalemia causes peaked T waves.' },
  { id: 'c2', content: 'Furosemide is a loop diuretic.' },
];

describe('question fingerprint cost gate (M7 spec Y/AD)', () => {
  it('is stable for identical inputs and concept-order independent', () => {
    const a = computeQuestionFingerprint(['hyperkalemia', 'furosemide'], chunks, metadata);
    const b = computeQuestionFingerprint(['furosemide', 'hyperkalemia'], chunks, metadata);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when content, concepts, or configuration change', () => {
    const base = computeQuestionFingerprint(['hyperkalemia'], chunks, metadata);
    expect(computeQuestionFingerprint(['hyperkalemia'], [chunks[0]!], metadata)).not.toBe(base);
    expect(computeQuestionFingerprint(['dka'], chunks, metadata)).not.toBe(base);
    expect(
      computeQuestionFingerprint(['hyperkalemia'], chunks, { ...metadata, promptVersion: 'p2' })
    ).not.toBe(base);
    expect(
      computeQuestionFingerprint(
        ['hyperkalemia'],
        [{ id: 'c1', content: 'Hyperkalemia causes peaked T waves!' }, chunks[1]!],
        metadata
      )
    ).not.toBe(base);
  });
});
