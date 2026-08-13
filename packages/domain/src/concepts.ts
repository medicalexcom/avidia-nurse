/**
 * Nursing concept domain vocabulary — M6 (spec A/B/I; Playbook §6/§10;
 * ADR-0014, ADR-0016).
 *
 * Pure shared vocabulary only: the controlled concept-type taxonomy, the
 * controlled relationship-type taxonomy, lifecycle statuses, and their
 * student-facing labels. Extraction, normalization, and persistence live in
 * `@avidia/knowledge` and the worker; screens consume these constants and
 * never re-declare them.
 *
 * The taxonomy is deliberately small (spec B): it exists to serve future
 * study logic (question targeting, prioritization, medication modes), not to
 * become a medical-terminology project. `other` is the pressure valve — an
 * unknown type from extraction is coerced to `other`, never rejected for
 * taxonomy reasons alone.
 */

export const CONCEPT_TYPES = [
  'disease_disorder',
  'pathophysiology',
  'sign_symptom',
  'assessment',
  'laboratory',
  'diagnostic',
  'medication',
  'intervention',
  'nursing_priority',
  'complication',
  'risk_factor',
  'procedure',
  'safety',
  'patient_education',
  'anatomy_physiology',
  'calculation',
  'other',
] as const;

export type ConceptType = (typeof CONCEPT_TYPES)[number];

export const CONCEPT_TYPE_LABELS: Record<ConceptType, string> = {
  disease_disorder: 'Disease / disorder',
  pathophysiology: 'Pathophysiology',
  sign_symptom: 'Sign / symptom',
  assessment: 'Assessment',
  laboratory: 'Laboratory',
  diagnostic: 'Diagnostic',
  medication: 'Medication',
  intervention: 'Intervention',
  nursing_priority: 'Nursing priority',
  complication: 'Complication',
  risk_factor: 'Risk factor',
  procedure: 'Procedure',
  safety: 'Safety',
  patient_education: 'Patient education',
  anatomy_physiology: 'Anatomy / physiology',
  calculation: 'Calculation',
  other: 'Other',
};

export function isConceptType(value: string): value is ConceptType {
  return (CONCEPT_TYPES as readonly string[]).includes(value);
}

/**
 * Concept lifecycle (spec A). AI-extracted concepts are 'active' on creation;
 * 'archived' is reserved for later user curation (hide without losing
 * provenance). There is no 'merged' status: deduplication happens before
 * insert (normalized key + alias resolution), so merging is a write-path
 * concern, not a lifecycle state.
 */
export const CONCEPT_STATUSES = ['active', 'archived'] as const;
export type ConceptStatus = (typeof CONCEPT_STATUSES)[number];

/**
 * Controlled relationship taxonomy (spec I; Playbook §10 relationship kinds).
 * Directed: source → target reads left to right, e.g.
 * "Hyperkalemia MAY_CAUSE Cardiac dysrhythmia",
 * "Furosemide TREATS Fluid volume excess",
 * "Hypokalemia ADVERSE_EFFECT_OF Furosemide".
 */
export const CONCEPT_RELATIONSHIP_TYPES = [
  'may_cause',
  'may_lead_to',
  'associated_with',
  'treats',
  'adverse_effect_of',
  'assessment_of',
  'commonly_confused_with',
  'prerequisite_of',
] as const;

export type ConceptRelationshipType = (typeof CONCEPT_RELATIONSHIP_TYPES)[number];

export const CONCEPT_RELATIONSHIP_LABELS: Record<ConceptRelationshipType, string> = {
  may_cause: 'may cause',
  may_lead_to: 'may lead to',
  associated_with: 'associated with',
  treats: 'treats',
  adverse_effect_of: 'adverse effect of',
  assessment_of: 'assessment of',
  commonly_confused_with: 'commonly confused with',
  prerequisite_of: 'prerequisite of',
};

export function isConceptRelationshipType(value: string): value is ConceptRelationshipType {
  return (CONCEPT_RELATIONSHIP_TYPES as readonly string[]).includes(value);
}

/**
 * Relationship review state (spec I "confidence/status"): everything AI
 * proposes stays 'proposed' until a later milestone adds curation; deterministic
 * study logic must treat 'proposed' as a hint, never as clinical ground truth.
 */
export const CONCEPT_RELATIONSHIP_STATUSES = ['proposed', 'confirmed'] as const;
export type ConceptRelationshipStatus = (typeof CONCEPT_RELATIONSHIP_STATUSES)[number];

/**
 * M6 knowledge lifecycle — a THIRD independent document lifecycle alongside
 * processing_status (M4, "can the student read this?") and index_status
 * (M5, "can study tools retrieve from this?"). knowledge_status answers
 * "have concepts been distilled from this document's chunks?".
 *
 *   pending -> extracting -> ready | failed;  failed/extracting -> pending (retry)
 *
 * Re-indexing (chunk changes) resets it to 'pending'. A knowledge failure
 * never affects reading or retrieval (spec T).
 */
export const KNOWLEDGE_STATUSES = ['pending', 'extracting', 'ready', 'failed'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];
