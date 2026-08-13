import {
  EVAL_EXPECTED_CONCEPT_KEYS,
  EVAL_EXTRACTION_CHUNKS,
  EVAL_RAW_EXTRACTION,
} from './evalFixtures';
import { refineExtraction, toRpcPayload } from './refine';
import { ExtractionChunk, RawExtraction } from './schema';

const chunks: ExtractionChunk[] = [
  { id: 'c0', locator: 'slide 1', content: 'a' },
  { id: 'c1', locator: 'slide 2', content: 'b' },
];

function raw(partial: Partial<RawExtraction>): RawExtraction {
  return { concepts: [], relationships: [], ...partial };
}

describe('refineExtraction', () => {
  it('drops generic candidates and records them for telemetry', () => {
    const refined = refineExtraction(
      raw({
        concepts: [
          { name: 'Patient', type: 'other', aliases: [], chunk_indexes: [0] },
          { name: 'Hyperkalemia', type: 'laboratory', aliases: [], chunk_indexes: [0] },
        ],
      }),
      chunks
    );
    expect(refined.concepts.map((concept) => concept.key)).toEqual(['hyperkalemia']);
    expect(refined.droppedNames).toEqual(['Patient']);
  });

  it('merges case/punctuation duplicates deterministically', () => {
    const refined = refineExtraction(
      raw({
        concepts: [
          {
            name: 'Diabetic Ketoacidosis',
            type: 'disease_disorder',
            aliases: [],
            chunk_indexes: [0],
          },
          {
            name: 'diabetic  ketoacidosis',
            type: 'disease_disorder',
            aliases: [],
            chunk_indexes: [1],
          },
        ],
      }),
      chunks
    );
    expect(refined.concepts).toHaveLength(1);
    expect(refined.concepts[0]!.chunkIds).toEqual(['c0', 'c1']);
  });

  it('merges an abbreviation into the concept that claims it as alias', () => {
    const refined = refineExtraction(
      raw({
        concepts: [
          {
            name: 'Diabetic Ketoacidosis',
            type: 'disease_disorder',
            aliases: ['DKA'],
            chunk_indexes: [0],
          },
          { name: 'DKA', type: 'disease_disorder', aliases: [], chunk_indexes: [1] },
        ],
      }),
      chunks
    );
    expect(refined.concepts).toHaveLength(1);
    const concept = refined.concepts[0]!;
    expect(concept.name).toBe('Diabetic Ketoacidosis');
    expect(concept.aliases.map((alias) => alias.alias)).toEqual(['DKA']);
    expect(concept.chunkIds).toEqual(['c0', 'c1']);
  });

  it('promotes the fullest name when the abbreviation arrived first', () => {
    const refined = refineExtraction(
      raw({
        concepts: [
          { name: 'COPD', type: 'disease_disorder', aliases: [], chunk_indexes: [0] },
          {
            name: 'Chronic Obstructive Pulmonary Disease',
            type: 'disease_disorder',
            aliases: ['COPD'],
            chunk_indexes: [1],
          },
        ],
      }),
      chunks
    );
    expect(refined.concepts).toHaveLength(1);
    const concept = refined.concepts[0]!;
    expect(concept.name).toBe('Chronic Obstructive Pulmonary Disease');
    expect(concept.key).toBe('chronic obstructive pulmonary disease');
    expect(concept.aliases.map((alias) => alias.key)).toContain('copd');
    expect(concept.chunkIds).toEqual(['c0', 'c1']);
  });

  it('never merges clinically distinct near-twins', () => {
    const refined = refineExtraction(
      raw({
        concepts: [
          { name: 'Hyperkalemia', type: 'laboratory', aliases: [], chunk_indexes: [0] },
          { name: 'Hypokalemia', type: 'laboratory', aliases: [], chunk_indexes: [0] },
        ],
      }),
      chunks
    );
    expect(refined.concepts.map((concept) => concept.key).sort()).toEqual([
      'hyperkalemia',
      'hypokalemia',
    ]);
  });

  it('coerces unknown concept types to other', () => {
    const refined = refineExtraction(
      raw({
        concepts: [{ name: 'Oxygen Titration', type: 'protocol', aliases: [], chunk_indexes: [0] }],
      }),
      chunks
    );
    expect(refined.concepts[0]!.type).toBe('other');
  });

  it('title-cases ALL-CAPS shouting but leaves acronyms alone', () => {
    const refined = refineExtraction(
      raw({
        concepts: [
          { name: 'HEART FAILURE', type: 'disease_disorder', aliases: [], chunk_indexes: [0] },
          { name: 'COPD', type: 'disease_disorder', aliases: [], chunk_indexes: [0] },
        ],
      }),
      chunks
    );
    const names = refined.concepts.map((concept) => concept.name).sort();
    expect(names).toEqual(['COPD', 'Heart Failure']);
  });

  it('drops relationships with unknown types, self-references, or lost endpoints', () => {
    const refined = refineExtraction(
      raw({
        concepts: [
          { name: 'Furosemide', type: 'medication', aliases: ['Lasix'], chunk_indexes: [0] },
          { name: 'Hypokalemia', type: 'laboratory', aliases: [], chunk_indexes: [1] },
        ],
        relationships: [
          { source: 'Furosemide', target: 'Hypokalemia', type: 'may_cause', chunk_index: 1 },
          { source: 'Lasix', target: 'Hypokalemia', type: 'may_cause', chunk_index: 1 }, // alias + dup
          { source: 'Furosemide', target: 'furosemide', type: 'associated_with', chunk_index: 0 },
          { source: 'Furosemide', target: 'Hypokalemia', type: 'cures', chunk_index: 1 },
          { source: 'Patient', target: 'Hypokalemia', type: 'associated_with', chunk_index: 1 },
        ],
      }),
      chunks
    );
    expect(refined.relationships).toEqual([
      { sourceKey: 'furosemide', targetKey: 'hypokalemia', type: 'may_cause', chunkId: 'c1' },
    ]);
  });
});

describe('extraction quality evaluation (spec U)', () => {
  const refined = refineExtraction(EVAL_RAW_EXTRACTION, EVAL_EXTRACTION_CHUNKS);

  it('recovers every expected major concept', () => {
    const keys = new Set(refined.concepts.map((concept) => concept.key));
    for (const expected of EVAL_EXPECTED_CONCEPT_KEYS) {
      expect(keys).toContain(expected);
    }
  });

  it('drops all generic junk candidates', () => {
    const keys = refined.concepts.map((concept) => concept.key);
    expect(keys).not.toContain('patient');
    expect(keys).not.toContain('blood');
    expect(keys).not.toContain('patient care');
    expect([...refined.droppedNames].sort()).toEqual(['Blood', 'Patient', 'patient care']);
  });

  it('merges DKA variants into one concept with the DKA alias', () => {
    const dkaConcepts = refined.concepts.filter(
      (concept) => concept.key === 'diabetic ketoacidosis' || concept.key === 'dka'
    );
    expect(dkaConcepts).toHaveLength(1);
    const dka = dkaConcepts[0]!;
    expect(dka.name).toBe('Diabetic Ketoacidosis');
    expect(dka.aliases.map((alias) => alias.key)).toContain('dka');
    expect(dka.summary).toContain('anion gap');
    expect(dka.chunkIds).toEqual(['chunk-dka']);
  });

  it('keeps hypokalemia and hyperkalemia separate', () => {
    const hyper = refined.concepts.find((concept) => concept.key === 'hyperkalemia');
    const hypo = refined.concepts.find((concept) => concept.key === 'hypokalemia');
    expect(hyper).toBeDefined();
    expect(hypo).toBeDefined();
    expect(hypo!.chunkIds).toEqual(['chunk-k', 'chunk-lasix']);
  });

  it('coerces the unknown type to other instead of dropping the concept', () => {
    const titration = refined.concepts.find((concept) =>
      concept.key.startsWith('oxygen titration')
    );
    expect(titration).toBeDefined();
    expect(titration!.type).toBe('other');
  });

  it('keeps exactly the four valid relationships with correct provenance', () => {
    expect(refined.relationships).toHaveLength(4);
    expect(refined.relationships).toContainEqual({
      sourceKey: 'hyperkalemia',
      targetKey: 'cardiac dysrhythmia',
      type: 'may_cause',
      chunkId: 'chunk-k',
    });
    expect(refined.relationships).toContainEqual({
      sourceKey: 'furosemide',
      targetKey: 'hypokalemia',
      type: 'may_cause',
      chunkId: 'chunk-lasix',
    });
    expect(refined.relationships).toContainEqual({
      sourceKey: 'furosemide',
      targetKey: 'heart failure',
      type: 'treats',
      chunkId: 'chunk-lasix',
    });
    expect(refined.relationships).toContainEqual({
      sourceKey: 'diabetic ketoacidosis',
      targetKey: 'metabolic acidosis',
      type: 'associated_with',
      chunkId: 'chunk-dka',
    });
  });

  it('is deterministic across repeated runs', () => {
    const again = refineExtraction(EVAL_RAW_EXTRACTION, EVAL_EXTRACTION_CHUNKS);
    expect(again).toEqual(refined);
  });
});

describe('toRpcPayload', () => {
  it('shapes the refined extraction for the apply_concept_extraction RPC', () => {
    const refined = refineExtraction(EVAL_RAW_EXTRACTION, EVAL_EXTRACTION_CHUNKS);
    const payload = toRpcPayload(refined, {
      provider: 'scripted',
      model: 'scripted-lexicon',
      promptVersion: 'p1',
      extractionVersion: 'v1',
    });
    expect(payload.extraction).toEqual({
      provider: 'scripted',
      model: 'scripted-lexicon',
      prompt_version: 'p1',
      extraction_version: 'v1',
    });
    expect(payload.concepts.length).toBe(refined.concepts.length);
    const dka = payload.concepts.find((concept) => concept.key === 'diabetic ketoacidosis')!;
    expect(dka.chunk_ids).toEqual(['chunk-dka']);
    expect(dka.aliases).toContainEqual({ alias: 'DKA', key: 'dka' });
    expect(payload.relationships).toContainEqual({
      source_key: 'furosemide',
      target_key: 'heart failure',
      type: 'treats',
      chunk_id: 'chunk-lasix',
    });
  });
});
