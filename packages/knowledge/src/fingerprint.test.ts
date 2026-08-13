import { computeKnowledgeFingerprint } from './fingerprint';

const metadata = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  promptVersion: 'p1',
  extractionVersion: 'v1',
};

const chunks = [
  { id: 'c0', content: 'Hyperkalemia causes peaked T waves.' },
  { id: 'c1', content: 'Furosemide may cause hypokalemia.' },
];

describe('computeKnowledgeFingerprint', () => {
  it('is stable for identical inputs', () => {
    expect(computeKnowledgeFingerprint(chunks, metadata)).toBe(
      computeKnowledgeFingerprint(chunks, metadata)
    );
  });

  it('produces a hex SHA-256 digest', () => {
    expect(computeKnowledgeFingerprint(chunks, metadata)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when chunk content changes', () => {
    const edited = [chunks[0]!, { id: 'c1', content: 'Furosemide may cause HYPOkalemia.' }];
    expect(computeKnowledgeFingerprint(edited, metadata)).not.toBe(
      computeKnowledgeFingerprint(chunks, metadata)
    );
  });

  it('changes when chunk ids or order change', () => {
    const reordered = [chunks[1]!, chunks[0]!];
    expect(computeKnowledgeFingerprint(reordered, metadata)).not.toBe(
      computeKnowledgeFingerprint(chunks, metadata)
    );
  });

  it('changes when any version metadata changes', () => {
    const base = computeKnowledgeFingerprint(chunks, metadata);
    expect(computeKnowledgeFingerprint(chunks, { ...metadata, model: 'gpt-4o' })).not.toBe(base);
    expect(computeKnowledgeFingerprint(chunks, { ...metadata, promptVersion: 'p2' })).not.toBe(
      base
    );
    expect(computeKnowledgeFingerprint(chunks, { ...metadata, extractionVersion: 'v2' })).not.toBe(
      base
    );
    expect(computeKnowledgeFingerprint(chunks, { ...metadata, provider: 'scripted' })).not.toBe(
      base
    );
  });

  it('does not confuse boundary-shifted chunk contents', () => {
    const a = [
      { id: 'c0', content: 'ab' },
      { id: 'c1', content: 'c' },
    ];
    const b = [
      { id: 'c0', content: 'a' },
      { id: 'c1', content: 'bc' },
    ];
    expect(computeKnowledgeFingerprint(a, metadata)).not.toBe(
      computeKnowledgeFingerprint(b, metadata)
    );
  });
});
