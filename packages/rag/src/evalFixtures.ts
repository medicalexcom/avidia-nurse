import { RetrievedChunk, SourceLocator } from './types';

/**
 * Retrieval-quality evaluation set (spec S). All content is legally safe
 * synthetic nursing lecture material written for this repository — no real
 * course uploads. Each fixture chunk mimics what M5 chunking would produce
 * from a slide deck or handout, and each eval query names the chunk ids a
 * good retriever must surface. Used by the retrieval-quality test with the
 * deterministic HashingEmbeddingProvider and an in-memory hybrid backend.
 */

export interface EvalChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  ordinal: number;
  content: string;
  sourceLocator: SourceLocator;
}

export interface EvalQuery {
  query: string;
  /** Chunk ids that must appear in the top-k results. */
  expectedChunkIds: string[];
}

const DOC_CARDIO = 'doc-cardio';
const DOC_RESP = 'doc-resp';
const DOC_ENDO = 'doc-endo';

export const EVAL_CHUNKS: EvalChunk[] = [
  {
    id: 'chunk-hf',
    documentId: DOC_CARDIO,
    documentTitle: 'Adult Health Module 3',
    ordinal: 0,
    content:
      'Heart Failure\nLeft-sided heart failure causes pulmonary congestion: crackles, dyspnea, orthopnea, and pink frothy sputum. Right-sided failure causes systemic venous congestion: jugular venous distention, peripheral edema, hepatomegaly, and weight gain. BNP is elevated. Daily weights are the best indicator of fluid status; report a gain of more than 2 to 3 pounds in a day.',
    sourceLocator: { type: 'pptx', slide: 4, title: 'Heart Failure' },
  },
  {
    id: 'chunk-furosemide',
    documentId: DOC_CARDIO,
    documentTitle: 'Adult Health Module 3',
    ordinal: 1,
    content:
      'Furosemide\nFurosemide is a loop diuretic used in heart failure and fluid overload. Monitor potassium closely: hypokalemia potentiates digoxin toxicity. Administer IV furosemide slowly to avoid ototoxicity. Expect increased urine output; monitor daily weight, intake and output, and orthostatic blood pressure.',
    sourceLocator: { type: 'pptx', slide: 9, title: 'Furosemide' },
  },
  {
    id: 'chunk-hyperkalemia',
    documentId: DOC_CARDIO,
    documentTitle: 'Adult Health Module 3',
    ordinal: 2,
    content:
      'Hyperkalemia\nHyperkalemia (potassium above 5.0 mEq/L) causes peaked T waves, widened QRS, and risk of ventricular arrhythmia. Causes include renal failure, potassium-sparing diuretics, and acidosis. Treatment: calcium gluconate to stabilize the myocardium, then insulin with dextrose to shift potassium into cells, and sodium polystyrene sulfonate to remove it.',
    sourceLocator: { type: 'pptx', slide: 14, title: 'Hyperkalemia' },
  },
  {
    id: 'chunk-pe',
    documentId: DOC_RESP,
    documentTitle: 'Respiratory Emergencies',
    ordinal: 0,
    content:
      'Pulmonary Embolism\nA pulmonary embolism presents with sudden dyspnea, pleuritic chest pain, tachycardia, tachypnea, and a sense of impending doom. Risk factors follow Virchow triad: venous stasis, vessel injury, hypercoagulability. Diagnosis: CT pulmonary angiography; D-dimer is sensitive but not specific. Anticoagulation with heparin; monitor aPTT and INR when bridging to warfarin.',
    sourceLocator: { type: 'pptx', slide: 17, title: 'Pulmonary Embolism' },
  },
  {
    id: 'chunk-copd',
    documentId: DOC_RESP,
    documentTitle: 'Respiratory Emergencies',
    ordinal: 1,
    content:
      'COPD\nChronic obstructive pulmonary disease combines emphysema and chronic bronchitis. Expect a decreased FEV1 to FVC ratio on spirometry, barrel chest, pursed-lip breathing, and chronic CO2 retention with elevated PaCO2. Give the lowest oxygen flow that keeps SpO2 88 to 92 percent. Smoking cessation is the single most effective intervention.',
    sourceLocator: { type: 'pptx', slide: 22, title: 'COPD' },
  },
  {
    id: 'chunk-dka',
    documentId: DOC_ENDO,
    documentTitle: 'Endocrine Handout',
    ordinal: 0,
    content:
      'Diabetic Ketoacidosis\nDKA presents with hyperglycemia above 300 mg/dL, ketones, metabolic acidosis, Kussmaul respirations, and fruity breath. Priority: isotonic fluids first, then a regular insulin infusion. Monitor potassium — insulin drives potassium into cells, so hypokalemia can develop rapidly. Add dextrose when glucose approaches 250 mg/dL.',
    sourceLocator: { type: 'docx', sectionIndex: 3, heading: 'Diabetic Ketoacidosis' },
  },
];

export const EVAL_QUERIES: EvalQuery[] = [
  { query: 'signs of left sided heart failure', expectedChunkIds: ['chunk-hf'] },
  { query: 'furosemide nursing considerations potassium', expectedChunkIds: ['chunk-furosemide'] },
  { query: 'peaked T waves treatment calcium gluconate', expectedChunkIds: ['chunk-hyperkalemia'] },
  { query: 'pulmonary embolism Virchow triad D-dimer', expectedChunkIds: ['chunk-pe'] },
  { query: 'COPD FEV1 PaCO2 oxygen target', expectedChunkIds: ['chunk-copd'] },
  { query: 'DKA Kussmaul respirations insulin infusion', expectedChunkIds: ['chunk-dka'] },
];

/** Shape an eval chunk as a retrieval hit (for grounding tests). */
export function asRetrievedChunk(chunk: EvalChunk, score = 0.5): RetrievedChunk {
  return {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    ordinal: chunk.ordinal,
    content: chunk.content,
    sourceLocator: chunk.sourceLocator,
    similarity: score,
    lexicalRank: 0,
    score,
  };
}
