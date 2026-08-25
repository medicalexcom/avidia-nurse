import { GenerationChunk, GenerationConcept, RawGeneratedQuestion } from './schema';

/**
 * Synthetic nursing generation-quality fixtures (M7 spec AI/AJ).
 *
 * Entirely written for this repository: realistic ABSN scenarios covering
 * hyperkalemia, DKA, pulmonary embolism, COPD, heart failure and furosemide.
 * NO NCLEX questions, NO commercial test-bank content, nothing copied from
 * courseware. The eval tests in validate.test.ts prove — repeatably, with no
 * API key — that the validation pipeline accepts well-formed clinical items,
 * rejects broken ones, and flags unsafe ones.
 */

export const EVAL_GENERATION_CONCEPTS: GenerationConcept[] = [
  { key: 'hyperkalemia', name: 'Hyperkalemia', type: 'laboratory', emphasisScore: 9 },
  {
    key: 'diabetic ketoacidosis',
    name: 'Diabetic Ketoacidosis',
    type: 'disease_disorder',
    emphasisScore: 8,
  },
  {
    key: 'pulmonary embolism',
    name: 'Pulmonary Embolism',
    type: 'disease_disorder',
    emphasisScore: 6,
  },
  { key: 'heart failure', name: 'Heart Failure', type: 'disease_disorder', emphasisScore: 6 },
  {
    key: 'chronic obstructive pulmonary disease',
    name: 'Chronic Obstructive Pulmonary Disease',
    type: 'disease_disorder',
    emphasisScore: 4,
  },
  { key: 'furosemide', name: 'Furosemide', type: 'medication', emphasisScore: 5 },
];

export const EVAL_GENERATION_CHUNKS: GenerationChunk[] = [
  {
    id: '00000000-0000-4000-8000-00000000e001',
    locator: 'slide 12 — Electrolytes',
    content:
      'Hyperkalemia (serum potassium above 5.0 mEq/L) causes peaked T waves and can ' +
      'progress to lethal dysrhythmias. Priority nursing actions: continuous cardiac ' +
      'monitoring, hold potassium-containing fluids, anticipate calcium gluconate.',
  },
  {
    id: '00000000-0000-4000-8000-00000000e002',
    locator: 'slide 20 — Endocrine emergencies',
    content:
      'Diabetic Ketoacidosis presents with blood glucose above 250 mg/dL, ketones, ' +
      'metabolic acidosis and Kussmaul respirations. Management: isotonic fluids first, ' +
      'then regular insulin infusion; monitor potassium closely as insulin drives it into cells.',
  },
  {
    id: '00000000-0000-4000-8000-00000000e003',
    locator: 'slide 31 — Respiratory',
    content:
      'Pulmonary Embolism: sudden dyspnea, pleuritic chest pain, tachycardia and ' +
      'hypoxia after immobility or surgery. Chronic Obstructive Pulmonary Disease ' +
      'exacerbations show increased sputum and accessory muscle use.',
  },
  {
    id: '00000000-0000-4000-8000-00000000e004',
    locator: 'slide 44 — Cardiac',
    content:
      'Heart Failure: crackles, S3, weight gain and edema signal fluid overload. ' +
      'Furosemide is a loop diuretic used to reduce preload; monitor potassium and ' +
      'daily weights. Furosemide 40 mg orally is a common starting dose.',
  },
];

/**
 * Raw generator output the pipeline must ACCEPT as clean 'generated'
 * questions (held for routine human review, never straight to 'active'):
 * clinical reasoning stems (spec D), correct interaction shapes, teaching
 * rationales, plausible distractors.
 */
export const EVAL_GOOD_QUESTIONS: RawGeneratedQuestion[] = [
  {
    question_type: 'single_best_answer',
    stem:
      'A client with renal failure has a serum potassium of 6.4 mEq/L and peaked T waves ' +
      'on the cardiac monitor. Which prescription should the nurse implement first?',
    difficulty: 'hard',
    cognitive_level: 'prioritization',
    concept_key: 'hyperkalemia',
    priority_frameworks: ['abc', 'unstable_vs_stable'],
    rationale:
      'Peaked T waves indicate cardiac membrane instability; calcium gluconate stabilizes ' +
      'the myocardium immediately while other measures lower the potassium level.',
    options: [
      {
        text: 'Administer intravenous calcium gluconate',
        is_correct: true,
        correct_position: null,
        rationale: 'Protects the myocardium from dysrhythmia right now.',
      },
      {
        text: 'Give the scheduled sodium polystyrene sulfonate dose',
        is_correct: false,
        correct_position: null,
        rationale: 'Removes potassium but works over hours — too slow for ECG changes.',
      },
      {
        text: 'Obtain a repeat serum potassium specimen',
        is_correct: false,
        correct_position: null,
        rationale: 'Confirmation must not delay treatment of an unstable client.',
      },
      {
        text: 'Restrict dietary potassium for the next meal tray',
        is_correct: false,
        correct_position: null,
        rationale: 'A long-term measure with no effect on the acute emergency.',
      },
    ],
    expected_value: null,
    tolerance: null,
    answer_unit: null,
    rounding_note: null,
    chunk_indexes: [0],
  },
  {
    question_type: 'multiple_response',
    stem:
      'A client admitted with diabetic ketoacidosis has a glucose of 480 mg/dL and deep, ' +
      'rapid respirations. Which findings should the nurse expect? Select all that apply.',
    difficulty: 'moderate',
    cognitive_level: 'understanding',
    concept_key: 'diabetic ketoacidosis',
    priority_frameworks: [],
    rationale:
      'DKA produces metabolic acidosis with compensatory Kussmaul respirations and ' +
      'ketones; bradycardia and weight gain are not features of DKA.',
    options: [
      {
        text: 'Positive serum ketones',
        is_correct: true,
        correct_position: null,
        rationale: 'Ketoacids define DKA.',
      },
      {
        text: 'Arterial pH below 7.35',
        is_correct: true,
        correct_position: null,
        rationale: 'Metabolic acidosis is a diagnostic criterion.',
      },
      {
        text: 'Kussmaul respirations',
        is_correct: true,
        correct_position: null,
        rationale: 'Deep rapid breathing compensates for the acidosis.',
      },
      {
        text: 'Bradycardia with bounding pulses',
        is_correct: false,
        correct_position: null,
        rationale: 'Dehydration in DKA produces tachycardia, not bradycardia.',
      },
      {
        text: 'Sudden weight gain with edema',
        is_correct: false,
        correct_position: null,
        rationale: 'Osmotic diuresis causes fluid loss, not overload.',
      },
    ],
    expected_value: null,
    tolerance: null,
    answer_unit: null,
    rounding_note: null,
    chunk_indexes: [1],
  },
  {
    question_type: 'ordered_response',
    stem:
      'A postoperative client suddenly develops dyspnea, pleuritic chest pain and an ' +
      'oxygen saturation of 84%. Place the nursing actions in priority order.',
    difficulty: 'hard',
    cognitive_level: 'prioritization',
    concept_key: 'pulmonary embolism',
    priority_frameworks: ['abc'],
    rationale:
      'Oxygenation comes first (airway/breathing), then positioning to ease breathing, ' +
      'then notifying the provider for definitive treatment, then documentation.',
    options: [
      {
        text: 'Apply high-flow oxygen',
        is_correct: false,
        correct_position: 1,
        rationale: 'Breathing takes priority; hypoxia is the immediate threat.',
      },
      {
        text: 'Raise the head of the bed',
        is_correct: false,
        correct_position: 2,
        rationale: 'Positioning supports oxygenation once oxygen is flowing.',
      },
      {
        text: 'Notify the rapid response team',
        is_correct: false,
        correct_position: 3,
        rationale: 'Definitive care requires the team, after immediate stabilization began.',
      },
      {
        text: 'Document the event and assessments',
        is_correct: false,
        correct_position: 4,
        rationale: 'Documentation never precedes life-preserving action.',
      },
    ],
    expected_value: null,
    tolerance: null,
    answer_unit: null,
    rounding_note: null,
    chunk_indexes: [2],
  },
  {
    question_type: 'numeric_calculation',
    stem:
      'The provider prescribes furosemide 40 mg by mouth daily for a client with heart ' +
      'failure. The pharmacy supplies 20 mg tablets. How many tablets should the nurse give?',
    difficulty: 'easy',
    cognitive_level: 'application',
    concept_key: 'furosemide',
    priority_frameworks: [],
    rationale: 'Dose ordered (40 mg) divided by dose on hand (20 mg per tablet) equals 2 tablets.',
    options: [],
    expected_value: 2,
    tolerance: 0,
    answer_unit: 'tablets',
    rounding_note: 'Answer with a whole number of tablets.',
    chunk_indexes: [3],
  },
];

/**
 * Raw generator output the pipeline must REJECT outright (spec K): broken
 * interaction shapes and answer leakage never reach the database as usable.
 */
export const EVAL_REJECTED_QUESTIONS: RawGeneratedQuestion[] = [
  {
    // Two correct options on a single_best_answer.
    ...EVAL_GOOD_QUESTIONS[0]!,
    options: EVAL_GOOD_QUESTIONS[0]!.options.map((option, index) => ({
      ...option,
      is_correct: index < 2,
    })),
  },
  {
    // Stem contains the correct answer verbatim (answer leakage).
    ...EVAL_GOOD_QUESTIONS[0]!,
    stem:
      'A client with hyperkalemia needs the nurse to administer intravenous calcium ' +
      'gluconate immediately. Which prescription should the nurse implement first?',
  },
];

/**
 * Raw generator output the pipeline must FLAG, not activate (spec L/N):
 * high-alert medication math without a unit, and giveaway absolute terms.
 */
export const EVAL_FLAGGED_QUESTIONS: RawGeneratedQuestion[] = [
  {
    question_type: 'numeric_calculation',
    stem:
      'A client requires an insulin infusion at 5 units per hour. The bag contains 100 ' +
      'units of regular insulin in 100 mL of normal saline. At what rate should the pump run?',
    difficulty: 'moderate',
    cognitive_level: 'application',
    concept_key: 'diabetic ketoacidosis',
    priority_frameworks: [],
    rationale: '100 units per 100 mL means 1 unit/mL, so 5 units/hr runs at 5 mL/hr.',
    options: [],
    expected_value: 5,
    tolerance: 0,
    answer_unit: null, // high-alert medication math without a unit → flag
    rounding_note: null,
    chunk_indexes: [1],
  },
  {
    ...EVAL_GOOD_QUESTIONS[0]!,
    options: EVAL_GOOD_QUESTIONS[0]!.options.map((option, index) =>
      index === 3 ? { ...option, text: 'Never give the client anything by mouth again' } : option
    ),
  },
];
