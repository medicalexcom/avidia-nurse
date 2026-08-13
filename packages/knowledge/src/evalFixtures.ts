import { ExtractionChunk, RawExtraction } from './schema';

/**
 * Synthetic nursing-education fixtures for repeatable concept-extraction
 * quality evaluation (M6 spec U). Written for this project — not copied from
 * any courseware. The RAW fixture deliberately contains the failure modes a
 * live model produces (generic nouns, case/punctuation duplicates, an
 * abbreviation posing as a separate concept, an unknown type, a
 * self-relationship) so the evaluation proves the pipeline repairs them.
 */

export const EVAL_EXTRACTION_CHUNKS: ExtractionChunk[] = [
  {
    id: 'chunk-dka',
    locator: 'slide 5 — Diabetic Ketoacidosis',
    content:
      'Diabetic Ketoacidosis (DKA)\n' +
      'Absolute insulin deficiency drives lipolysis and ketone production, causing ' +
      'metabolic acidosis with an elevated anion gap. Expect Kussmaul respirations, ' +
      'fruity breath, dehydration. Priority: IV fluids, then regular insulin infusion; ' +
      'monitor potassium closely before and during insulin.',
  },
  {
    id: 'chunk-k',
    locator: 'slide 9 — Potassium Imbalances',
    content:
      'Hyperkalemia (K+ > 5.0 mEq/L) may cause peaked T waves and life-threatening ' +
      'cardiac dysrhythmias. Causes include renal failure and acidosis. ' +
      'Hypokalemia (K+ < 3.5 mEq/L) causes muscle weakness and flat T waves.',
  },
  {
    id: 'chunk-lasix',
    locator: 'slide 14 — Loop Diuretics',
    content:
      'Furosemide (Lasix) is a loop diuretic used in heart failure and fluid volume ' +
      'excess. Monitor potassium: furosemide may cause hypokalemia. Teach patients ' +
      'to report muscle cramps and to take the dose in the morning.',
  },
  {
    id: 'chunk-copd',
    locator: 'page 4 — COPD Exacerbation',
    content:
      'Chronic Obstructive Pulmonary Disease (COPD): airflow limitation confirmed by ' +
      'FEV1/FVC below 0.70. During exacerbation titrate oxygen to SpO2 88–92%. ' +
      'The patient with CO2 retention depends on hypoxic drive.',
  },
];

/**
 * A realistic RAW model response for the chunks above, including the junk the
 * refinement stage must handle. Kept schema-valid on purpose: schema-invalid
 * shapes are exercised separately in schema/gateway tests.
 */
export const EVAL_RAW_EXTRACTION: RawExtraction = {
  concepts: [
    {
      name: 'Diabetic Ketoacidosis',
      type: 'disease_disorder',
      summary: 'Insulin deficiency causing ketosis and high anion gap metabolic acidosis.',
      aliases: ['DKA'],
      chunk_indexes: [0],
    },
    // Abbreviation posing as its own concept → must merge into the alias.
    { name: 'DKA', type: 'disease_disorder', aliases: [], chunk_indexes: [0] },
    // Case/punctuation duplicate → must merge deterministically.
    { name: 'diabetic ketoacidosis', type: 'disease_disorder', aliases: [], chunk_indexes: [0] },
    { name: 'Kussmaul Respirations', type: 'sign_symptom', aliases: [], chunk_indexes: [0] },
    { name: 'Metabolic Acidosis', type: 'laboratory', aliases: [], chunk_indexes: [0, 1] },
    { name: 'Hyperkalemia', type: 'laboratory', aliases: [], chunk_indexes: [1] },
    // Clinically DISTINCT near-twin — must never merge with hyperkalemia.
    { name: 'Hypokalemia', type: 'laboratory', aliases: [], chunk_indexes: [1, 2] },
    { name: 'Cardiac Dysrhythmia', type: 'complication', aliases: [], chunk_indexes: [1] },
    { name: 'Furosemide', type: 'medication', aliases: ['Lasix'], chunk_indexes: [2] },
    { name: 'Heart Failure', type: 'disease_disorder', aliases: ['HF'], chunk_indexes: [2] },
    {
      name: 'Chronic Obstructive Pulmonary Disease',
      type: 'disease_disorder',
      aliases: ['COPD'],
      chunk_indexes: [3],
    },
    // Unknown type → coerced to 'other', not dropped.
    { name: 'Oxygen Titration 88-92%', type: 'protocol', aliases: [], chunk_indexes: [3] },
    // Generic junk → must be dropped entirely.
    { name: 'Patient', type: 'other', aliases: [], chunk_indexes: [0, 1, 2, 3] },
    { name: 'Blood', type: 'other', aliases: [], chunk_indexes: [1] },
    { name: 'patient care', type: 'other', aliases: [], chunk_indexes: [2] },
  ],
  relationships: [
    { source: 'Hyperkalemia', target: 'Cardiac Dysrhythmia', type: 'may_cause', chunk_index: 1 },
    { source: 'Furosemide', target: 'Hypokalemia', type: 'may_cause', chunk_index: 2 },
    { source: 'Furosemide', target: 'Heart Failure', type: 'treats', chunk_index: 2 },
    { source: 'DKA', target: 'Metabolic Acidosis', type: 'associated_with', chunk_index: 0 },
    // Self-relationship → must be dropped.
    { source: 'Hypokalemia', target: 'hypokalemia', type: 'associated_with', chunk_index: 1 },
    // Unknown relationship type → must be dropped.
    { source: 'Furosemide', target: 'Hyperkalemia', type: 'cures', chunk_index: 2 },
    // Endpoint that never survived extraction → must be dropped.
    { source: 'Patient', target: 'Hyperkalemia', type: 'associated_with', chunk_index: 1 },
  ],
};

/** Major concepts the evaluation requires (spec U "expected major concepts"). */
export const EVAL_EXPECTED_CONCEPT_KEYS = [
  'diabetic ketoacidosis',
  'hyperkalemia',
  'hypokalemia',
  'furosemide',
  'heart failure',
  'chronic obstructive pulmonary disease',
  'metabolic acidosis',
  'kussmaul respirations',
  'cardiac dysrhythmia',
] as const;
