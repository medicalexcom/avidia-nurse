/**
 * Deterministic concept-name normalization and generic-term filtering
 * (M6 spec D/F, ADR-0015).
 *
 * Normalization produces the course-scoped deduplication key: obvious
 * variants ("DKA", "D.K.A.", "diabetic ketoacidosis ") converge on the same
 * key deterministically, BEFORE any AI-assisted merging is considered.
 * The rules are intentionally conservative — they fold case, punctuation,
 * and whitespace, but never letters: "hyperkalemia" and "hypokalemia" are
 * one character apart and clinically opposite, so nothing fuzzy (edit
 * distance, stemming, phonetics) is allowed here.
 */

/** Bounds shared with the database CHECK constraints (migration 0006). */
export const MIN_CONCEPT_NAME_LENGTH = 2;
export const MAX_CONCEPT_NAME_LENGTH = 200;

/**
 * Deterministic normalization key: lowercase, Unicode-compatibility fold,
 * punctuation to spaces (hyphens included, so "beta-blocker" and
 * "beta blocker" merge), collapsed whitespace. NEVER changes letters or
 * digits themselves.
 */
export function normalizeConceptKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Terms that are never educationally meaningful concepts on their own
 * (spec D "not every noun"). Checked against the NORMALIZED key. This backs
 * up the extraction prompt; it is not the primary filter.
 */
const GENERIC_TERMS = new Set([
  'patient',
  'patients',
  'client',
  'clients',
  'nurse',
  'nurses',
  'nursing',
  'doctor',
  'physician',
  'provider',
  'hospital',
  'clinic',
  'unit',
  'body',
  'blood',
  'heart',
  'lungs',
  'care',
  'health',
  'disease',
  'condition',
  'symptom',
  'symptoms',
  'treatment',
  'medication',
  'medications',
  'drug',
  'drugs',
  'lab',
  'labs',
  'test',
  'tests',
  'assessment',
  'intervention',
  'education',
  'safety',
  'chapter',
  'lecture',
  'slide',
  'module',
  'objective',
  'objectives',
  'overview',
  'introduction',
  'summary',
  'review',
  'question',
  'questions',
  'exam',
  'quiz',
  'notes',
]);

/**
 * True when a candidate name is unusable as a concept: too short/long, no
 * letters, or a generic standalone term. Multi-word candidates are only
 * rejected when EVERY word is generic ("patient care"), never when a generic
 * word is part of a specific phrase ("heart failure").
 */
export function isMeaninglessConceptName(name: string): boolean {
  const key = normalizeConceptKey(name);
  if (key.length < MIN_CONCEPT_NAME_LENGTH || key.length > MAX_CONCEPT_NAME_LENGTH) {
    return true;
  }
  if (!/[a-z]/.test(key)) {
    return true;
  }
  const words = key.split(' ');
  return words.every((word) => GENERIC_TERMS.has(word));
}
