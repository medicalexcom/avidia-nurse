import { EVAL_CHUNKS, asRetrievedChunk } from './evalFixtures';
import { buildGroundingContext } from './grounding';

describe('buildGroundingContext', () => {
  it('labels every source S1, S2, … and pairs each with a cited text block', () => {
    const results = [
      asRetrievedChunk(
        EVAL_CHUNKS.find((c) => c.id === 'chunk-pe')!,
        0.9
      ),
      asRetrievedChunk(
        EVAL_CHUNKS.find((c) => c.id === 'chunk-dka')!,
        0.7
      ),
    ];
    const context = buildGroundingContext('pulmonary embolism findings', results);

    expect(context.query).toBe('pulmonary embolism findings');
    expect(context.insufficient).toBe(false);
    expect(context.sources.map((s) => s.label)).toEqual(['S1', 'S2']);

    const first = context.sources[0]!;
    expect(first.chunkId).toBe('chunk-pe');
    expect(first.documentTitle).toBe('Respiratory Emergencies');
    expect(first.citation).toBe(
      'Respiratory Emergencies \u2014 slide 17 \u2014 Pulmonary Embolism'
    );
    expect(first.score).toBe(0.9);
    expect(first.sourceLocator).toEqual({
      type: 'pptx',
      slide: 17,
      title: 'Pulmonary Embolism',
    });

    const second = context.sources[1]!;
    expect(second.citation).toBe(
      'Endocrine Handout \u2014 section \u201cDiabetic Ketoacidosis\u201d'
    );

    expect(context.textBlocks).toHaveLength(2);
    expect(context.textBlocks[0]!.startsWith(`[S1] (${first.citation})\n`)).toBe(true);
    expect(context.textBlocks[0]).toContain('Virchow triad');
    expect(context.textBlocks[1]!.startsWith(`[S2] (${second.citation})\n`)).toBe(true);
  });

  it('marks empty retrieval as insufficient so callers never fabricate attribution', () => {
    const context = buildGroundingContext('quantum mechanics', []);
    expect(context.insufficient).toBe(true);
    expect(context.sources).toEqual([]);
    expect(context.textBlocks).toEqual([]);
  });
});
