import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConceptRelationshipType, ConceptStatus, ConceptType } from '@avidia/domain';
import type { SourceLocator } from '@avidia/rag';

/**
 * Read-only data access for course concepts (M6 spec P/Q/R).
 *
 * Everything here is SELECT-only: students never write concept tables (the
 * database grants no client insert/update/delete, and all persistence goes
 * through the worker-only apply_concept_extraction RPC). Ownership is
 * enforced server-side by RLS through courses.user_id — a guessed concept id
 * belonging to another user returns no rows, indistinguishable from
 * "does not exist".
 */

export interface ConceptListRow {
  id: string;
  course_id: string;
  canonical_name: string;
  concept_type: ConceptType;
  summary: string | null;
  status: ConceptStatus;
  emphasis_score: number;
  /** Number of source-chunk links supporting this concept. */
  source_count: number;
}

export interface ConceptAliasRow {
  id: string;
  alias: string;
}

/** One piece of "Found in" evidence: a chunk this concept was taught in. */
export interface ConceptEvidenceRow {
  chunk_id: string;
  document_id: string;
  document_name: string;
  locator: SourceLocator | null;
}

export interface ConceptRelationshipRow {
  id: string;
  relationship_type: ConceptRelationshipType;
  /** Canonical name of the concept on the other end. */
  other_name: string;
  other_id: string;
  /** 'outgoing' = this concept is the source; 'incoming' = the target. */
  direction: 'outgoing' | 'incoming';
}

export interface ConceptDetail {
  concept: ConceptListRow;
  aliases: ConceptAliasRow[];
  evidence: ConceptEvidenceRow[];
  relationships: ConceptRelationshipRow[];
}

interface ConceptQueryRow {
  id: string;
  course_id: string;
  canonical_name: string;
  concept_type: ConceptType;
  summary: string | null;
  status: ConceptStatus;
  emphasis_score: number | string;
  concept_sources: { count: number }[];
}

function toListRow(row: ConceptQueryRow): ConceptListRow {
  return {
    id: row.id,
    course_id: row.course_id,
    canonical_name: row.canonical_name,
    concept_type: row.concept_type,
    summary: row.summary,
    status: row.status,
    // numeric columns arrive as strings from PostgREST.
    emphasis_score: Number(row.emphasis_score),
    source_count: row.concept_sources[0]?.count ?? 0,
  };
}

/**
 * Active concepts of a course ordered for studying: strongest course emphasis
 * first, then alphabetically for a stable, scannable list.
 */
export async function listConcepts(
  client: SupabaseClient,
  courseId: string
): Promise<ConceptListRow[]> {
  const { data, error } = await client
    .from('concepts')
    .select(
      'id, course_id, canonical_name, concept_type, summary, status, emphasis_score, concept_sources(count)'
    )
    .eq('course_id', courseId)
    .eq('status', 'active')
    .order('emphasis_score', { ascending: false })
    .order('canonical_name', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as ConceptQueryRow[]).map(toListRow);
}

interface EvidenceQueryRow {
  chunk_id: string;
  document_id: string;
  source_chunks: {
    source_locator: SourceLocator | null;
    documents: { original_filename: string } | null;
  } | null;
}

interface RelationshipQueryRow {
  id: string;
  relationship_type: ConceptRelationshipType;
  source_concept_id: string;
  target_concept_id: string;
  source: { canonical_name: string } | null;
  target: { canonical_name: string } | null;
}

/**
 * One concept with its aliases, source evidence ("Found in: …"), and
 * material-supported relationships. Returns null when the concept does not
 * exist — or is not the caller's, which RLS makes look identical.
 */
export async function fetchConceptDetail(
  client: SupabaseClient,
  conceptId: string
): Promise<ConceptDetail | null> {
  const { data: conceptRow, error: conceptError } = await client
    .from('concepts')
    .select(
      'id, course_id, canonical_name, concept_type, summary, status, emphasis_score, concept_sources(count)'
    )
    .eq('id', conceptId)
    .maybeSingle();
  if (conceptError) throw conceptError;
  if (!conceptRow) return null;

  const [aliasResult, evidenceResult, outgoingResult, incomingResult] = await Promise.all([
    client
      .from('concept_aliases')
      .select('id, alias')
      .eq('concept_id', conceptId)
      .order('alias', { ascending: true }),
    client
      .from('concept_sources')
      .select('chunk_id, document_id, source_chunks(source_locator, documents(original_filename))')
      .eq('concept_id', conceptId),
    client
      .from('concept_relationships')
      .select(
        'id, relationship_type, source_concept_id, target_concept_id, target:concepts!concept_relationships_target_concept_id_fkey(canonical_name)'
      )
      .eq('source_concept_id', conceptId),
    client
      .from('concept_relationships')
      .select(
        'id, relationship_type, source_concept_id, target_concept_id, source:concepts!concept_relationships_source_concept_id_fkey(canonical_name)'
      )
      .eq('target_concept_id', conceptId),
  ]);
  if (aliasResult.error) throw aliasResult.error;
  if (evidenceResult.error) throw evidenceResult.error;
  if (outgoingResult.error) throw outgoingResult.error;
  if (incomingResult.error) throw incomingResult.error;

  const evidence = ((evidenceResult.data ?? []) as unknown as EvidenceQueryRow[]).map((row) => ({
    chunk_id: row.chunk_id,
    document_id: row.document_id,
    document_name: row.source_chunks?.documents?.original_filename ?? 'Course material',
    locator: row.source_chunks?.source_locator ?? null,
  }));

  const outgoing = ((outgoingResult.data ?? []) as unknown as RelationshipQueryRow[]).map(
    (row): ConceptRelationshipRow => ({
      id: row.id,
      relationship_type: row.relationship_type,
      other_name: row.target?.canonical_name ?? 'Unknown concept',
      other_id: row.target_concept_id,
      direction: 'outgoing',
    })
  );
  const incoming = ((incomingResult.data ?? []) as unknown as RelationshipQueryRow[]).map(
    (row): ConceptRelationshipRow => ({
      id: row.id,
      relationship_type: row.relationship_type,
      other_name: row.source?.canonical_name ?? 'Unknown concept',
      other_id: row.source_concept_id,
      direction: 'incoming',
    })
  );

  return {
    concept: toListRow(conceptRow as unknown as ConceptQueryRow),
    aliases: (aliasResult.data ?? []) as ConceptAliasRow[],
    evidence,
    relationships: [...outgoing, ...incoming],
  };
}
