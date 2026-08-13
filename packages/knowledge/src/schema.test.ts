import { CONCEPT_RELATIONSHIP_TYPES, CONCEPT_TYPES } from '@avidia/domain';

import { extractionJsonSchema, validateExtraction } from './schema';

const valid = {
  concepts: [
    {
      name: 'Hyperkalemia',
      type: 'laboratory',
      summary: 'Serum potassium above 5.0 mEq/L.',
      aliases: ['High K+'],
      chunk_indexes: [0],
    },
  ],
  relationships: [
    { source: 'Hyperkalemia', target: 'Cardiac Dysrhythmia', type: 'may_cause', chunk_index: 0 },
  ],
};

describe('validateExtraction', () => {
  it('accepts a well-formed extraction', () => {
    const result = validateExtraction(valid, 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.concepts).toHaveLength(1);
      expect(result.value.relationships).toHaveLength(1);
    }
  });

  it('rejects non-object responses', () => {
    expect(validateExtraction('not json', 1).ok).toBe(false);
    expect(validateExtraction(null, 1).ok).toBe(false);
    expect(validateExtraction([], 1).ok).toBe(false);
  });

  it('rejects missing or malformed concepts array', () => {
    const result = validateExtraction({ relationships: [] }, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('concepts must be an array');
    }
  });

  it('rejects empty names, missing aliases, and uncited concepts', () => {
    const result = validateExtraction(
      {
        concepts: [{ name: '  ', type: 'laboratory', chunk_indexes: [] }],
        relationships: [],
      },
      1
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.includes('name'))).toBe(true);
      expect(result.errors.some((error) => error.includes('aliases'))).toBe(true);
      expect(result.errors.some((error) => error.includes('at least one chunk'))).toBe(true);
    }
  });

  it('bounds chunk indexes to the submitted batch', () => {
    const outOfRange = {
      concepts: [{ name: 'Hyperkalemia', type: 'laboratory', aliases: [], chunk_indexes: [2] }],
      relationships: [],
    };
    expect(validateExtraction(outOfRange, 2).ok).toBe(false);
    expect(validateExtraction(outOfRange, 3).ok).toBe(true);
  });

  it('rejects non-integer and negative chunk indexes', () => {
    const bad = (index: unknown) =>
      validateExtraction(
        {
          concepts: [
            { name: 'DKA', type: 'disease_disorder', aliases: [], chunk_indexes: [index] },
          ],
          relationships: [],
        },
        4
      );
    expect(bad(1.5).ok).toBe(false);
    expect(bad(-1).ok).toBe(false);
    expect(bad('0').ok).toBe(false);
  });

  it('rejects relationships with missing fields or out-of-range evidence', () => {
    const result = validateExtraction(
      {
        concepts: valid.concepts,
        relationships: [{ source: 'Hyperkalemia', target: '', type: 'may_cause', chunk_index: 9 }],
      },
      1
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.includes('target'))).toBe(true);
      expect(result.errors.some((error) => error.includes('chunk_index'))).toBe(true);
    }
  });

  it('treats missing relationships as an empty array', () => {
    const result = validateExtraction({ concepts: valid.concepts }, 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.relationships).toEqual([]);
    }
  });

  it('does NOT reject unknown concept types (coerced later, spec E)', () => {
    const result = validateExtraction(
      {
        concepts: [{ name: 'Oxygen Titration', type: 'protocol', aliases: [], chunk_indexes: [0] }],
        relationships: [],
      },
      1
    );
    expect(result.ok).toBe(true);
  });

  it('enforces batch and per-field limits', () => {
    const many = {
      concepts: Array.from({ length: 61 }, (_, index) => ({
        name: `Concept ${index}`,
        type: 'other',
        aliases: [],
        chunk_indexes: [0],
      })),
      relationships: [],
    };
    expect(validateExtraction(many, 1).ok).toBe(false);

    const longSummary = {
      concepts: [
        {
          name: 'Hyperkalemia',
          type: 'laboratory',
          summary: 'x'.repeat(1001),
          aliases: [],
          chunk_indexes: [0],
        },
      ],
      relationships: [],
    };
    expect(validateExtraction(longSummary, 1).ok).toBe(false);

    const tooManyAliases = {
      concepts: [
        {
          name: 'Hyperkalemia',
          type: 'laboratory',
          aliases: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
          chunk_indexes: [0],
        },
      ],
      relationships: [],
    };
    expect(validateExtraction(tooManyAliases, 1).ok).toBe(false);
  });
});

describe('extractionJsonSchema', () => {
  it('constrains types to the controlled taxonomies', () => {
    const schema = extractionJsonSchema(CONCEPT_TYPES, CONCEPT_RELATIONSHIP_TYPES);
    expect(schema.properties.concepts.items.properties.type.enum).toEqual([...CONCEPT_TYPES]);
    expect(schema.properties.relationships.items.properties.type.enum).toEqual([
      ...CONCEPT_RELATIONSHIP_TYPES,
    ]);
    expect(schema.additionalProperties).toBe(false);
  });
});
