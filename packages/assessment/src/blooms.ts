/**
 * Bloom's Taxonomy cognitive progression and question selection (Skill #3).
 *
 * Implements learning-science-based question sequencing:
 * Students progress through cognitive levels (recall → synthesis) to build
 * competency from foundational knowledge to clinical reasoning mastery.
 */

import { CognitiveLevel, COGNITIVE_LEVELS, QuestionDifficulty } from '@avidia/domain';

/**
 * Bloom's Taxonomy level groups for study progression.
 */
export const BLOOMS_LEVELS = {
  foundational: ['recall', 'understanding'] as const,
  intermediate: ['application', 'analysis'] as const,
  advanced: ['evaluation', 'synthesis'] as const,
};

export type BlomsLevelGroup = keyof typeof BLOOMS_LEVELS;

export function getLevelGroup(level: CognitiveLevel): BlomsLevelGroup {
  if (BLOOMS_LEVELS.foundational.includes(level as any)) return 'foundational';
  if (BLOOMS_LEVELS.intermediate.includes(level as any)) return 'intermediate';
  return 'advanced';
}

/**
 * Skill #3: Mastery bands determine which cognitive levels to emphasize.
 *
 * - Unassessed (0% mastery): Start with recall + understanding (build foundation)
 * - Low (0-40%): Mix recall/understanding + easy application (early reasoning)
 * - Developing (40-75%): Emphasis on application + analysis (clinical reasoning)
 * - Strong (75%+): Focus on analysis + evaluation (deep mastery)
 */
export interface MasteryBandTargets {
  level: 'unassessed' | 'low' | 'developing' | 'strong';
  masteryRange: [number, number];
  /** Cognitive levels to emphasize at this mastery band. */
  primaryLevels: CognitiveLevel[];
  /** Secondary levels (can include but not emphasize). */
  secondaryLevels: CognitiveLevel[];
  /** Preferred difficulties for this mastery band. */
  preferredDifficulties: QuestionDifficulty[];
  /** Brief description for student visibility. */
  description: string;
}

export const MASTERY_BAND_TARGETS: MasteryBandTargets[] = [
  {
    level: 'unassessed',
    masteryRange: [0, 0],
    primaryLevels: ['recall', 'understanding'],
    secondaryLevels: ['application'],
    preferredDifficulties: ['easy'],
    description: 'Build foundational knowledge: facts, definitions, concepts',
  },
  {
    level: 'low',
    masteryRange: [0.01, 0.4],
    primaryLevels: ['recall', 'understanding', 'application'],
    secondaryLevels: ['analysis'],
    preferredDifficulties: ['easy', 'moderate'],
    description: 'Strengthen basics and begin clinical reasoning',
  },
  {
    level: 'developing',
    masteryRange: [0.4, 0.75],
    primaryLevels: ['application', 'analysis'],
    secondaryLevels: ['understanding', 'evaluation'],
    preferredDifficulties: ['moderate', 'hard'],
    description: 'Master clinical decision-making and reasoning',
  },
  {
    level: 'strong',
    masteryRange: [0.75, 1],
    primaryLevels: ['analysis', 'evaluation', 'synthesis'],
    secondaryLevels: ['application'],
    preferredDifficulties: ['moderate', 'hard'],
    description: 'Demonstrate mastery and handle complex scenarios',
  },
];

/**
 * Get targets for a specific mastery level (0-1 scale).
 */
export function getTargetsForMastery(mastery: number | null): MasteryBandTargets {
  if (mastery === null || mastery === 0) return MASTERY_BAND_TARGETS[0]!;
  if (mastery < 0.4) return MASTERY_BAND_TARGETS[1]!;
  if (mastery < 0.75) return MASTERY_BAND_TARGETS[2]!;
  return MASTERY_BAND_TARGETS[3]!;
}

/**
 * Skill #3: Sequence cognitive levels for progressive learning.
 * Returns levels in recommended study order for a concept.
 */
export function getProgressionPath(startLevel: BlomsLevelGroup = 'foundational'): CognitiveLevel[] {
  if (startLevel === 'foundational') {
    return ['recall', 'understanding', 'application', 'analysis', 'evaluation', 'synthesis'];
  } else if (startLevel === 'intermediate') {
    return ['application', 'analysis', 'evaluation', 'synthesis', 'understanding', 'recall'];
  }
  return ['evaluation', 'synthesis', 'analysis', 'application', 'understanding', 'recall'];
}

/**
 * Skill #3: Check if question meets mastery band targets.
 * Returns true if question's cognitive level aligns with student's current mastery.
 */
export function meetsLevelTargets(
  questionLevel: CognitiveLevel,
  targetLevels: CognitiveLevel[],
  allowSecondary: boolean = true
): boolean {
  return (
    targetLevels.includes(questionLevel) || (allowSecondary && targetLevels.includes(questionLevel))
  );
}

/**
 * Skill #3: Estimate percentage of Bloom's level coverage in a question set.
 * Used to ensure balanced progression across levels.
 */
export interface BlomsLevelCoverage {
  recall: number;
  understanding: number;
  application: number;
  analysis: number;
  evaluation: number;
  synthesis: number;
  prioritization: number;
}

export function calculateBlomsLevelCoverage(levels: CognitiveLevel[]): BlomsLevelCoverage {
  const coverage: BlomsLevelCoverage = {
    recall: 0,
    understanding: 0,
    application: 0,
    analysis: 0,
    evaluation: 0,
    synthesis: 0,
    prioritization: 0,
  };

  const total = levels.length;
  if (total === 0) return coverage;

  for (const level of levels) {
    coverage[level] = (coverage[level] + 1) / total;
  }

  return coverage;
}

/**
 * Skill #3: Recommend next progression based on current coverage.
 * Example: If mostly recall questions, recommend understanding next.
 */
export function recommendNextLevel(currentCoverage: BlomsLevelCoverage): CognitiveLevel | null {
  const levels = [
    'recall',
    'understanding',
    'application',
    'analysis',
    'evaluation',
    'synthesis',
    'prioritization',
  ] as const;
  const sorted = [...levels].sort((a, b) => currentCoverage[a] - currentCoverage[b]);

  // Recommend the level with least coverage
  if (sorted[0] && currentCoverage[sorted[0]] < 1 / levels.length) {
    return sorted[0];
  }

  return null;
}

/**
 * Skill #3: Generate prompt suffix for requesting specific Bloom's levels.
 * Used when generating question batches for targeted learning.
 */
export function generateBlomsPromptSuffix(
  targetLevels: CognitiveLevel[] | BlomsLevelGroup,
  minPerLevel: number = 1
): string {
  const levels = Array.isArray(targetLevels)
    ? targetLevels
    : (BLOOMS_LEVELS[targetLevels] as CognitiveLevel[]);

  const levelDescriptions = {
    recall: 'recall (facts, definitions, terminology)',
    understanding: 'understanding (explain, summarize, classify)',
    application: 'application (apply to new situations, solve problems)',
    analysis: 'analysis (identify relationships, distinguish causes)',
    evaluation: 'evaluation (make judgments, defend positions)',
    synthesis: 'synthesis (combine elements, create new patterns)',
    prioritization: 'prioritization (nursing-specific ordering and decision-making)',
  };

  const levelList = levels.map((l) => `- ${levelDescriptions[l] || l}`).join('\n');

  return (
    `\nCognitive Level Progression:\nGenerate at least ${minPerLevel} question(s) for EACH of these Bloom's levels:\n${levelList}\n` +
    `Mix these levels to build comprehensive mastery from foundational to deep reasoning.`
  );
}
