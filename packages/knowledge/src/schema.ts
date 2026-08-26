import { isConceptRelationshipType, isConceptType } from '@avidia/domain';

/**
 * Strict structured-output contract for AI concept extraction (M6 spec E,
 * ADR-0016). AI output is UNTRUSTED input: everything is validated field by
 * field before it may influence the database. Anything that fails validation
 * is rejected (the gateway then attempts one controlled repair round);
 * arbitrary JSON never reaches persistence.
 *
 * ENHANCEMENT: Prerequisite relationship detection for learning path scaffolding.
 */

/** One chunk given to the extractor, with its stable id and provenance hint. */
export interface ExtractionChunk {
  /** source_chunks.id — ties every extracted concept back to evidence. */
  id: string;
  content: string;
  /** Human-readable provenance ("slide 17 — Pulmonary Embolism") for the prompt. */
  locator: string;
}

/** Raw (already schema-validated) candidate from the model. */
export interface RawConceptCandidate {
  name: string;
  /** Must be a taxonomy value; unknown types are coerced to 'other' later. */
  type: string;
  /** Optional one-sentence grounded summary. */
  summary?: string;
  aliases: string[];
  /** 0-based indexes into the submitted chunk batch that support the concept. */
  chunk_indexes: number[];
}

export interface RawRelationshipCandidate {
  /** Concept names as written in `concepts` (matched after normalization). */
  source: string;
  target: string;
  type: string;
  /** 0-based index of the chunk that evidences the relationship. */
  chunk_index: number;
  /** NEW: Prerequisite strength [1-10], higher = stronger prerequisite (required). */
  prerequisite_strength?: number | null;
  /** NEW: Whether target MUST know source before studying (boolean flag). */
  is_prerequisite?: boolean;
}

export interface RawExtraction {
  concepts: RawConceptCandidate[];
  relationships: RawRelationshipCandidate[];
}

export type SchemaResult = { ok: true; value: RawExtraction } | { ok: false; errors: string[] };

const MAX_CONCEPTS_PER_BATCH = 60;
const MAX_RELATIONSHIPS_PER_BATCH = 60;
const MAX_ALIASES_PER_CONCEPT = 6;
const MAX_PREREQUISITE_STRENGTH = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isIndexArray(value: unknown, chunkCount: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item < chunkCount
    )
  );
}

/**
 * Validate a parsed model response against the extraction schema. `chunkCount`
 * bounds every chunk index — the model can only cite chunks it was shown.
 * Structural violations are errors (reject/repair); merely unknown concept or
 * relationship TYPES are not (they are coerced/dropped during refinement, so
 * one taxonomy hallucination cannot discard an otherwise good batch).
 */
export function validateExtraction(raw: unknown, chunkCount: number): SchemaResult {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: ['response is not a JSON object'] };
  }
  const concepts = raw.concepts;
  const relationships = raw.relationships ?? [];
  if (!Array.isArray(concepts)) {
    errors.push('concepts must be an array');
  } else {
    if (concepts.length > MAX_CONCEPTS_PER_BATCH) {
      errors.push(`too many concepts (${concepts.length} > ${MAX_CONCEPTS_PER_BATCH})`);
    }
    concepts.forEach((concept, index) => {
      if (!isRecord(concept)) {
        errors.push(`concepts[${index}] is not an object`);
        return;
      }
      if (typeof concept.name !== 'string' || concept.name.trim().length === 0) {
        errors.push(`concepts[${index}].name must be a non-empty string`);
      }
      if (typeof concept.type !== 'string') {
        errors.push(`concepts[${index}].type must be a string`);
      }
      if (
        concept.summary !== undefined &&
        (typeof concept.summary !== 'string' || concept.summary.length > 1000)
      ) {
        errors.push(`concepts[${index}].summary must be a string of at most 1000 characters`);
      }
      if (!isStringArray(concept.aliases)) {
        errors.push(`concepts[${index}].aliases must be an array of strings`);
      } else if (concept.aliases.length > MAX_ALIASES_PER_CONCEPT) {
        errors.push(`concepts[${index}].aliases has more than ${MAX_ALIASES_PER_CONCEPT} entries`);
      }
      if (!isIndexArray(concept.chunk_indexes, chunkCount)) {
        errors.push(`concepts[${index}].chunk_indexes must be integers in [0, ${chunkCount - 1}]`);
      } else if (concept.chunk_indexes.length === 0) {
        errors.push(`concepts[${index}].chunk_indexes must cite at least one chunk`);
      }
    });
  }
  if (!Array.isArray(relationships)) {
    errors.push('relationships must be an array when present');
  } else {
    if (relationships.length > MAX_RELATIONSHIPS_PER_BATCH) {
      errors.push(`too many relationships (${relationships.length})`);
    }
    relationships.forEach((relationship, index) => {
      if (!isRecord(relationship)) {
        errors.push(`relationships[${index}] is not an object`);
        return;
      }
      for (const field of ['source', 'target', 'type'] as const) {
        const value = relationship[field];
        if (typeof value !== 'string' || value.length === 0) {
          errors.push(`relationships[${index}].${field} must be a non-empty string`);
        }
      }
      if (!isIndexArray([relationship.chunk_index], chunkCount)) {
        errors.push(
          `relationships[${index}].chunk_index must be an integer in [0, ${chunkCount - 1}]`
        );
      }
      // NEW: Validate prerequisite strength if present
      if (
        relationship.prerequisite_strength !== undefined &&
        relationship.prerequisite_strength !== null &&
        (typeof relationship.prerequisite_strength !== 'number' ||
          !Number.isInteger(relationship.prerequisite_strength) ||
          relationship.prerequisite_strength < 1 ||
          relationship.prerequisite_strength > MAX_PREREQUISITE_STRENGTH)
      ) {
        errors.push(
          `relationships[${index}].prerequisite_strength must be null or an integer in [1, ${MAX_PREREQUISITE_STRENGTH}]`
        );
      }
      // NEW: Validate is_prerequisite if present
      if (
        relationship.is_prerequisite !== undefined &&
        typeof relationship.is_prerequisite !== 'boolean'
      ) {
        errors.push(`relationships[${index}].is_prerequisite must be a boolean when present`);
      }
    });
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      concepts: concepts as unknown as RawConceptCandidate[],
      relationships: relationships as unknown as RawRelationshipCandidate[],
    },
  };
}

/**
 * JSON Schema handed to providers that support constrained decoding (OpenAI
 * structured outputs). Kept in lockstep with validateExtraction — constrained
 * decoding reduces repair rounds, but validateExtraction remains the
 * authority (spec E: never trust arbitrary model JSON).
 */
export function extractionJsonSchema(
  conceptTypes: readonly string[],
  relationshipTypes: readonly string[]
) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['concepts', 'relationships'],
    properties: {
      concepts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'type', 'summary', 'aliases', 'chunk_indexes'],
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: [...conceptTypes] },
            summary: { type: 'string' },
            aliases: { type: 'array', items: { type: 'string' } },
            chunk_indexes: { type: 'array', items: { type: 'integer' } },
          },
        },
      },
      relationships: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['source', 'target', 'type', 'chunk_index', 'prerequisite_strength', 'is_prerequisite'],
          properties: {
            source: { type: 'string' },
            target: { type: 'string' },
            type: { type: 'string', enum: [...relationshipTypes] },
            chunk_index: { type: 'integer' },
            prerequisite_strength: { type: ['integer', 'null'] },
            is_prerequisite: { type: 'boolean' },
          },
        },
      },
    },
  } as const;
}

/** Convenience guards re-exported for refinement. */
export { isConceptRelationshipType, isConceptType };
