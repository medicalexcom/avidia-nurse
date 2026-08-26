import type { CognitiveLevel, ConfidenceLevel, QuestionDifficulty } from '@avidia/domain';

/** Version of the mastery-update algorithm. */
export const MASTERY_ALGORITHM_VERSION = 1;
export const MASTERY_MIN = 0;
export const MASTERY_MAX = 1;
export const GAIN_RATE = 0.3;
export const DROP_RATE = 0.4;
export const GAIN_CAP = 0.25;
export const DROP_CAP = 0.3;
export const DROP_FLOOR = 0.35;
export const WEIGHT_RANGE = { min: 0.25, max: 2.0 } as const;

export const DIFFICULTY_WEIGHT_CORRECT: Record<QuestionDifficulty, number> = {
  easy: 0.8,
  moderate: 1.0,
  hard: 1.25,
};
export const DIFFICULTY_WEIGHT_INCORRECT: Record<QuestionDifficulty, number> = {
  easy: 1.25,
  moderate: 1.0,
  hard: 0.8,
};

export const COGNITIVE_WEIGHT_CORRECT: Record<CognitiveLevel, number> = {
  recall: 0.85,
  understanding: 0.95,
  application: 1.1,
  analysis: 1.2,
  evaluation: 1.2,
  synthesis: 1.25,
  prioritization: 1.25,
};
export const COGNITIVE_WEIGHT_INCORRECT = 1.0;

export const CONFIDENCE_WEIGHT_CORRECT: Record<ConfidenceLevel, number> = {
  guessing: 0.55,
  unsure: 0.8,
  pretty_sure: 1.0,
  certain: 1.1,
};
export const CONFIDENCE_WEIGHT_INCORRECT: Record<ConfidenceLevel, number> = {
  guessing: 0.85,
  unsure: 0.9,
  pretty_sure: 1.05,
  certain: 1.15,
};
export const CONFIDENCE_WEIGHT_NEUTRAL = 1.0;
export const RESPONSE_TIME_FACTOR = 1.0;

export const MISCONCEPTION_INCREMENT = {
  certain: 0.3,
  pretty_sure: 0.2,
  other_incorrect: 0.1,
} as const;
export const MISCONCEPTION_DECAY_ON_CORRECT = 0.5;
export const MISCONCEPTION_SIGNAL_THRESHOLD = 0.5;

export const REVIEW_INTERVALS_HOURS = [24, 72, 168, 336, 720] as const;
export const STATE_THRESHOLDS = {
  NEEDS_REVIEW_BELOW: 0.4,
  STRONG_AT: 0.75,
} as const;

export const PRIORITY = {
  WEAKNESS_MASTERY_SCALE: 0.85,
  EXAM_URGENCY_SCALE: 1.5,
  EMPHASIS_SCALE: 0.5,
  TRANSFER_NEED_BONUS: 1.25,
  UNASSESSED_WEAKNESS: 1.0,
  UNASSESSED_FORGETTING_RISK: 0.6,
  FORGETTING_RISK_FLOOR: 0.15,
} as const;

export const EXAM_URGENCY_STEPS: ReadonlyArray<{ maxDays: number; urgency: number }> = [
  { maxDays: 0, urgency: 1.0 },
  { maxDays: 1, urgency: 0.95 },
  { maxDays: 3, urgency: 0.8 },
  { maxDays: 7, urgency: 0.55 },
  { maxDays: 14, urgency: 0.3 },
];
export const EXAM_URGENCY_BEYOND = 0.1;
export const RECENT_ERROR_WINDOW_HOURS = 72;
export const HIGH_EMPHASIS_THRESHOLD = 0.7;

export const DIVERSITY = {
  MAX_CONSECUTIVE_SAME_CONCEPT: 2,
  MAX_CONCEPT_SHARE: 0.5,
} as const;

export const QUESTION_SUPPLY_LOW_THRESHOLD = 3;

export const TARGET_CHARACTERISTICS = {
  low: {
    difficulties: ['easy', 'moderate'] as QuestionDifficulty[],
    cognitiveLevels: ['recall', 'understanding', 'application'] as CognitiveLevel[],
  },
  mid: {
    difficulties: ['moderate', 'hard'] as QuestionDifficulty[],
    cognitiveLevels: ['understanding', 'application', 'analysis'] as CognitiveLevel[],
  },
  high: {
    difficulties: ['moderate', 'hard'] as QuestionDifficulty[],
    cognitiveLevels: ['application', 'analysis', 'prioritization'] as CognitiveLevel[],
  },
} as const;
