/**
 * Study-mode registry — M10 (spec A/B/C/E/F/G/I/S/T).
 *
 * A pure, extensible catalog of the advanced study modes. Each mode is a
 * deterministic FILTER plus a seeded ORDERING over the course's existing
 * validated question bank (spec AG — no separate game content, no separate
 * game mastery). Adding a mode means adding one entry here; no screen code
 * contains per-mode conditionals (spec B).
 *
 * The shared activity contract (spec A) is the machinery that already
 * exists: every mode presents rows from `questions`, records answers through
 * `submit_question_attempt`, and therefore feeds M8 exactly the same
 * normalized evidence as practice and adaptive study. Nothing here computes
 * mastery, scores answers, or weights evidence — those live server-side and
 * in `@avidia/mastery` (spec O/P).
 */

import { buildSessionQuestionOrder } from '@avidia/assessment/src/mix';
import type {
  CognitiveLevel,
  ConceptType,
  PriorityFramework,
  QuestionDifficulty,
  QuestionType,
} from '@avidia/domain';

/** The five M10 modes (blueprint scope: Low–Medium complexity, in-scope). */
export const MODE_IDS = [
  'rapid_response',
  'find_the_danger',
  'who_first',
  'medication_lab',
  'boss_battle',
] as const;

export type ModeId = (typeof MODE_IDS)[number];

export function isModeId(value: string | null | undefined): value is ModeId {
  return typeof value === 'string' && (MODE_IDS as readonly string[]).includes(value);
}

/** The question facts a mode may filter on — a subset of the M7 row. */
export interface ModeQuestion {
  id: string;
  conceptId: string | null;
  questionType: QuestionType;
  difficulty: QuestionDifficulty;
  cognitiveLevel: CognitiveLevel;
  priorityFrameworks: readonly PriorityFramework[];
}

/** An ordered mode session: question ids plus optional labeled segments. */
export interface ModePlan {
  questionIds: string[];
  /**
   * Consecutive labeled stretches of the plan (Boss Battle rounds). Empty
   * for single-segment modes.
   */
  segments: { label: string; count: number }[];
}

export interface ModeDefinition {
  id: ModeId;
  title: string;
  /** One-line student-facing purpose (learning-first, never pressuring). */
  tagline: string;
  /** Minimum eligible questions before the mode unlocks (spec S/T). */
  minQuestions: number;
  /** Student-facing line shown while the mode is locked (spec T). */
  lockedMessage: string;
  /** Whether one question belongs to this mode's drill. Deterministic. */
  includesQuestion: (question: ModeQuestion, conceptType: ConceptType | null) => boolean;
  /**
   * Deterministic seeded ordering of the eligible pool. Game modes use a
   * FIXED order for the whole session — mid-session re-ranking stays an
   * adaptive-mode behavior only.
   */
  buildOrder: (eligible: readonly ModeQuestion[], count: number, seed: string) => ModePlan;
}

/** Concept types that describe risk, deterioration, or safety cues. */
const DANGER_CONCEPT_TYPES: readonly ConceptType[] = [
  'safety',
  'complication',
  'sign_symptom',
  'risk_factor',
  'assessment',
];

const toMixable = (question: ModeQuestion) => ({
  id: question.id,
  conceptId: question.conceptId,
  questionType: question.questionType,
  difficulty: question.difficulty,
});

/** Default ordering: the M7 concept-balanced seeded mix, one segment. */
function mixedOrder(eligible: readonly ModeQuestion[], count: number, seed: string): ModePlan {
  const questionIds = buildSessionQuestionOrder([...eligible].map(toMixable), count, seed).map(
    (item) => item.id
  );
  return { questionIds, segments: [] };
}

/** Boss Battle rounds, in fixed pedagogical order (spec I/J). */
export const BOSS_ROUNDS: readonly {
  label: string;
  levels: readonly CognitiveLevel[];
}[] = [
  { label: 'Foundation', levels: ['recall', 'understanding'] },
  { label: 'Application', levels: ['application'] },
  { label: 'Prioritization', levels: ['analysis', 'prioritization'] },
];

/**
 * Boss Battle ordering (spec I/J/K): Foundation → Application →
 * Prioritization rounds drawn from the SAME validated bank, each round
 * internally concept-balanced with its own derived seed, then an Integrated
 * final round mixing whatever eligible questions remain. Rounds a course's
 * bank cannot fill simply do not appear — the battle shrinks honestly, it
 * never fabricates content (spec X-equivalent).
 */
function bossBattleOrder(eligible: readonly ModeQuestion[], count: number, seed: string): ModePlan {
  const questionIds: string[] = [];
  const segments: { label: string; count: number }[] = [];
  const used = new Set<string>();
  // Reserve roughly a quarter of the session for the Integrated round when
  // enough questions exist to make it meaningful.
  const integratedTarget = count >= 8 ? Math.floor(count / 4) : 0;
  const roundBudget = count - integratedTarget;
  const roundPools = BOSS_ROUNDS.map((round) =>
    eligible.filter((question) => round.levels.includes(question.cognitiveLevel))
  );
  const poolTotal = roundPools.reduce((sum, pool) => sum + pool.length, 0);
  BOSS_ROUNDS.forEach((round, index) => {
    const pool = roundPools[index]!;
    if (pool.length === 0 || poolTotal === 0) return;
    const remainingBudget = roundBudget - questionIds.length;
    if (remainingBudget <= 0) return;
    // Proportional share of the round budget, at least one question.
    const share = Math.max(1, Math.round((pool.length / poolTotal) * roundBudget));
    const take = Math.min(share, pool.length, remainingBudget);
    const ids = buildSessionQuestionOrder(pool.map(toMixable), take, `${seed}:round-${index}`).map(
      (item) => item.id
    );
    if (ids.length === 0) return;
    ids.forEach((id) => used.add(id));
    questionIds.push(...ids);
    segments.push({ label: round.label, count: ids.length });
  });
  const leftover = eligible.filter((question) => !used.has(question.id));
  const integratedTake = Math.min(count - questionIds.length, leftover.length);
  if (integratedTake > 0) {
    const ids = buildSessionQuestionOrder(
      leftover.map(toMixable),
      integratedTake,
      `${seed}:integrated`
    ).map((item) => item.id);
    questionIds.push(...ids);
    segments.push({ label: 'Integrated', count: ids.length });
  }
  return { questionIds, segments };
}

/**
 * The registry. Filters are intentionally conservative: a question appears
 * in a drill only when its stored facts (type, cognitive level, priority
 * frameworks, concept type) say it belongs — never a guess (spec N).
 */
export const MODES: readonly ModeDefinition[] = [
  {
    id: 'rapid_response',
    title: 'Rapid Response',
    tagline:
      'Quick-fire recall of core facts. Accuracy is what counts — take the time you need; speed never changes your mastery.',
    minQuestions: 4,
    lockedMessage:
      'Rapid Response unlocks once your course has foundational recall questions. Upload more material to build the bank.',
    includesQuestion: (question) =>
      (question.cognitiveLevel === 'recall' || question.cognitiveLevel === 'understanding') &&
      question.difficulty !== 'hard',
    buildOrder: mixedOrder,
  },
  {
    id: 'find_the_danger',
    title: 'Find the Danger',
    tagline: 'Spot the finding that matters most — the cue a nurse cannot afford to miss.',
    minQuestions: 4,
    lockedMessage:
      'Find the Danger unlocks when your course has safety, complication, or assessment questions.',
    includesQuestion: (question, conceptType) =>
      (question.questionType === 'single_best_answer' ||
        question.questionType === 'multiple_response') &&
      ((conceptType !== null && DANGER_CONCEPT_TYPES.includes(conceptType)) ||
        question.priorityFrameworks.includes('safety')),
    buildOrder: mixedOrder,
  },
  {
    id: 'who_first',
    title: 'Who First?',
    tagline: 'Prioritization drills: decide who needs the nurse first, and be able to defend it.',
    minQuestions: 4,
    lockedMessage:
      'Who First? unlocks when your course has prioritization questions. They appear as your materials cover triage and priority-setting.',
    includesQuestion: (question) =>
      question.cognitiveLevel === 'prioritization' || question.priorityFrameworks.length > 0,
    buildOrder: mixedOrder,
  },
  {
    id: 'medication_lab',
    title: 'Medication Lab',
    tagline: 'Pharmacology practice from your own course: medications, effects, and calculations.',
    minQuestions: 4,
    lockedMessage:
      'Medication Lab unlocks when your course materials cover medications. Upload pharmacology content to open it.',
    includesQuestion: (question, conceptType) =>
      conceptType === 'medication' ||
      conceptType === 'calculation' ||
      question.questionType === 'numeric_calculation',
    buildOrder: mixedOrder,
  },
  {
    id: 'boss_battle',
    title: 'Boss Battle',
    tagline:
      'A cumulative challenge across everything you have studied — foundation to prioritization.',
    minQuestions: 8,
    lockedMessage:
      'Boss Battle unlocks once your course bank has at least 8 validated questions to draw from.',
    includesQuestion: () => true,
    buildOrder: bossBattleOrder,
  },
];

export function getMode(id: ModeId): ModeDefinition {
  return MODES.find((mode) => mode.id === id)!;
}

/** The eligible sub-pool of a mode, in stable input order. */
export function eligibleQuestions(
  mode: ModeDefinition,
  questions: readonly ModeQuestion[],
  conceptTypeById: ReadonlyMap<string, ConceptType>
): ModeQuestion[] {
  return questions.filter((question) =>
    mode.includesQuestion(
      question,
      question.conceptId === null ? null : (conceptTypeById.get(question.conceptId) ?? null)
    )
  );
}

export interface ModeAvailability {
  mode: ModeDefinition;
  availableCount: number;
  eligible: boolean;
}

/** Availability of every mode for one course (spec S/T). */
export function modeAvailability(
  questions: readonly ModeQuestion[],
  conceptTypeById: ReadonlyMap<string, ConceptType>
): ModeAvailability[] {
  return MODES.map((mode) => {
    const availableCount = eligibleQuestions(mode, questions, conceptTypeById).length;
    return { mode, availableCount, eligible: availableCount >= mode.minQuestions };
  });
}

/** The segment label for a position in a ModePlan (Boss Battle rounds). */
export function segmentLabelAt(plan: ModePlan, index: number): string | null {
  let offset = 0;
  for (const segment of plan.segments) {
    if (index < offset + segment.count) return segment.label;
    offset += segment.count;
  }
  return null;
}
