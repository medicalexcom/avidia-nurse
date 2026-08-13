import {
  ConceptRelationshipType,
  ConceptType,
  isConceptRelationshipType,
  isConceptType,
} from '@avidia/domain';

import { isMeaninglessConceptName, normalizeConceptKey } from './normalize';
import { ExtractionChunk, RawExtraction } from './schema';

/**
 * Refinement (M6 spec D/F/G): turn schema-valid but still-raw model output
 * into the deterministic, deduplicated payload the apply_concept_extraction
 * RPC persists. All merging here is DETERMINISTIC (normalized-key equality
 * and explicit alias claims); nothing fuzzy ever merges two names.
 */

export interface RefinedAlias {
  alias: string;
  key: string;
}

export interface RefinedConcept {
  /** Deterministic dedup key (normalizeConceptKey of name). */
  key: string;
  /** Display form, e.g. "Diabetic Ketoacidosis". */
  name: string;
  type: ConceptType;
  summary: string | null;
  aliases: RefinedAlias[];
  /** source_chunks ids that support this concept (deduplicated). */
  chunkIds: string[];
}

export interface RefinedRelationship {
  sourceKey: string;
  targetKey: string;
  type: ConceptRelationshipType;
  chunkId: string;
}

export interface RefinedExtraction {
  concepts: RefinedConcept[];
  relationships: RefinedRelationship[];
  /** Candidates dropped as generic/meaningless (spec D) — kept for telemetry. */
  droppedNames: string[];
}

/** Prefer Title-case-ish display when the model shouts in ALL CAPS. */
function displayName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed.length > 4 && trimmed === trimmed.toUpperCase() && /[A-Z]{5,}/.test(trimmed)) {
    return trimmed.toLowerCase().replace(/(^|\s)([a-z])/g, (match) => match.toUpperCase());
  }
  return trimmed;
}

/**
 * Merge, filter, and normalize one batch of raw extraction output.
 *
 * - drops meaningless/generic candidates ("patient", "blood") and records them;
 * - merges candidates whose names OR aliases collide after normalization
 *   ("DKA" + "Diabetic Ketoacidosis" with alias DKA → one concept, keeping
 *   the fullest name as canonical and the shorter as alias);
 * - coerces unknown concept types to 'other' (taxonomy is controlled, spec B);
 * - drops relationships with unknown types, self-references, or endpoints
 *   that did not survive filtering;
 * - maps chunk indexes to real source_chunks ids.
 */
export function refineExtraction(
  raw: RawExtraction,
  chunks: readonly ExtractionChunk[]
): RefinedExtraction {
  const byKey = new Map<string, RefinedConcept>();
  /** alias key -> concept key that claimed it first. */
  const aliasOwner = new Map<string, string>();
  const droppedNames: string[] = [];

  for (const candidate of raw.concepts) {
    const name = displayName(candidate.name);
    if (isMeaninglessConceptName(name)) {
      droppedNames.push(name);
      continue;
    }
    const key = normalizeConceptKey(name);
    const chunkIds = [...new Set(candidate.chunk_indexes.map((index) => chunks[index]!.id))];
    const aliasCandidates = candidate.aliases
      .map((alias) => ({
        alias: alias.trim().replace(/\s+/g, ' '),
        key: normalizeConceptKey(alias),
      }))
      .filter(
        (alias) =>
          alias.key.length >= 2 && alias.key !== key && !isMeaninglessConceptName(alias.alias)
      );

    // Deterministic resolution: the candidate's own key, or an alias claim
    // that points at an existing concept, or one of its aliases matching an
    // existing concept's key.
    let targetKey = byKey.has(key) ? key : aliasOwner.get(key);
    if (!targetKey) {
      targetKey = aliasCandidates.map((alias) => alias.key).find((aliasKey) => byKey.has(aliasKey));
    }

    if (targetKey && byKey.has(targetKey)) {
      const existing = byKey.get(targetKey)!;
      // Prefer the fullest name as canonical; keep the shorter as alias.
      if (name.length > existing.name.length && targetKey !== key) {
        byKey.delete(targetKey);
        aliasOwner.set(targetKey, key);
        existing.aliases.push({ alias: existing.name, key: existing.key });
        existing.name = name;
        existing.key = key;
        byKey.set(key, existing);
        targetKey = key;
      }
      const merged = byKey.get(targetKey)!;
      merged.chunkIds = [...new Set([...merged.chunkIds, ...chunkIds])];
      if (!merged.summary && candidate.summary) {
        merged.summary = candidate.summary.trim() || null;
      }
      for (const alias of aliasCandidates) {
        if (alias.key !== merged.key && !aliasOwner.has(alias.key) && !byKey.has(alias.key)) {
          merged.aliases.push(alias);
          aliasOwner.set(alias.key, merged.key);
        }
      }
      continue;
    }

    const refined: RefinedConcept = {
      key,
      name,
      type: isConceptType(candidate.type) ? candidate.type : 'other',
      summary: candidate.summary?.trim() ? candidate.summary.trim() : null,
      aliases: [],
      chunkIds,
    };
    byKey.set(key, refined);
    for (const alias of aliasCandidates) {
      if (!aliasOwner.has(alias.key) && !byKey.has(alias.key)) {
        refined.aliases.push(alias);
        aliasOwner.set(alias.key, key);
      }
    }
  }

  const resolveKey = (name: string): string | undefined => {
    const key = normalizeConceptKey(name);
    if (byKey.has(key)) return key;
    return aliasOwner.get(key);
  };

  const relationships: RefinedRelationship[] = [];
  const seen = new Set<string>();
  for (const candidate of raw.relationships) {
    if (!isConceptRelationshipType(candidate.type)) continue;
    const sourceKey = resolveKey(candidate.source);
    const targetKey = resolveKey(candidate.target);
    if (!sourceKey || !targetKey || sourceKey === targetKey) continue;
    const dedupKey = `${sourceKey}→${targetKey}→${candidate.type}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    relationships.push({
      sourceKey,
      targetKey,
      type: candidate.type,
      chunkId: chunks[candidate.chunk_index]!.id,
    });
  }

  return {
    concepts: [...byKey.values()].sort((a, z) => a.key.localeCompare(z.key)),
    relationships,
    droppedNames,
  };
}

/** Shape of the payload the apply_concept_extraction RPC consumes. */
export interface ExtractionRpcPayload {
  extraction: {
    provider: string;
    model: string;
    prompt_version: string;
    extraction_version: string;
  };
  concepts: {
    key: string;
    name: string;
    type: ConceptType;
    summary: string | null;
    aliases: { alias: string; key: string }[];
    chunk_ids: string[];
  }[];
  relationships: {
    source_key: string;
    target_key: string;
    type: ConceptRelationshipType;
    chunk_id: string;
  }[];
}

export function toRpcPayload(
  refined: RefinedExtraction,
  metadata: { provider: string; model: string; promptVersion: string; extractionVersion: string }
): ExtractionRpcPayload {
  return {
    extraction: {
      provider: metadata.provider,
      model: metadata.model,
      prompt_version: metadata.promptVersion,
      extraction_version: metadata.extractionVersion,
    },
    concepts: refined.concepts.map((concept) => ({
      key: concept.key,
      name: concept.name,
      type: concept.type,
      summary: concept.summary,
      aliases: concept.aliases,
      chunk_ids: concept.chunkIds,
    })),
    relationships: refined.relationships.map((relationship) => ({
      source_key: relationship.sourceKey,
      target_key: relationship.targetKey,
      type: relationship.type,
      chunk_id: relationship.chunkId,
    })),
  };
}
