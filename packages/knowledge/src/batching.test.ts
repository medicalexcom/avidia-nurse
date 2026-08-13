import {
  MAX_EXTRACTION_BATCH_CHUNKS,
  MAX_EXTRACTION_BATCH_TOKENS,
  batchExtractionChunks,
} from './batching';
import { ExtractionChunk } from './schema';

function chunk(id: string, length: number): ExtractionChunk {
  return { id, locator: id, content: 'x'.repeat(length) };
}

describe('batchExtractionChunks', () => {
  it('returns no batches for no chunks', () => {
    expect(batchExtractionChunks([])).toEqual([]);
  });

  it('keeps small documents in a single batch', () => {
    const chunks = [chunk('a', 400), chunk('b', 400), chunk('c', 400)];
    expect(batchExtractionChunks(chunks)).toEqual([chunks]);
  });

  it('splits when the token budget would be exceeded', () => {
    // 100 tokens each (400 chars / 4) with a budget of 250 → 2 + 2.
    const chunks = [chunk('a', 400), chunk('b', 400), chunk('c', 400), chunk('d', 400)];
    const batches = batchExtractionChunks(chunks, 250, MAX_EXTRACTION_BATCH_CHUNKS);
    expect(batches.map((batch) => batch.map((c) => c.id))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('splits when the chunk-count cap is reached', () => {
    const chunks = Array.from({ length: 5 }, (_, index) => chunk(`c${index}`, 4));
    const batches = batchExtractionChunks(chunks, MAX_EXTRACTION_BATCH_TOKENS, 2);
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
  });

  it('never drops or reorders chunks', () => {
    const chunks = Array.from({ length: 30 }, (_, index) => chunk(`c${index}`, 900));
    const batches = batchExtractionChunks(chunks);
    expect(batches.flat().map((c) => c.id)).toEqual(chunks.map((c) => c.id));
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(MAX_EXTRACTION_BATCH_CHUNKS);
    }
  });

  it('gives an oversized single chunk its own batch instead of losing it', () => {
    const chunks = [chunk('big', 40000), chunk('small', 40)];
    const batches = batchExtractionChunks(chunks);
    expect(batches).toHaveLength(2);
    expect(batches[0]![0]!.id).toBe('big');
    expect(batches[1]![0]!.id).toBe('small');
  });
});
