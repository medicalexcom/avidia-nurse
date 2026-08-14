/**
 * Built-in case library (spec AE/AF): a small, high-quality set of fully
 * validated cases. Quality over quantity — each case has deterministic
 * optimal/delayed/unsafe branch tests pinning its behavior (spec AZ/BA).
 */

import type { SimulationCaseDefinition } from '../types';
import { postopPeCase } from './postopPe';
import { hypoglycemiaCase } from './hypoglycemia';
import { hyperkalemiaCase } from './hyperkalemia';

export { postopPeCase, hypoglycemiaCase, hyperkalemiaCase };

export const BUILTIN_CASES: SimulationCaseDefinition[] = [
  postopPeCase,
  hypoglycemiaCase,
  hyperkalemiaCase,
];
