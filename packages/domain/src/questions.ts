  intermediate: ['application', 'analysis'] as const,
  advanced: ['evaluation', 'synthesis'] as const,
};

export type BlomsLevelGroup = keyof typeof BLOOMS_LEVEL_GROUPS;

export function isBlomsLevelGroup(value: string): value is BlomsLevelGroup {
  return value in BLOOMS_LEVEL_GROUPS;
}

export function getCognitiveLevelGroup(level: CognitiveLevel): BlomsLevelGroup {
  const foundational: readonly CognitiveLevel[] = BLOOMS_LEVEL_GROUPS.foundational;
  const intermediate: readonly CognitiveLevel[] = BLOOMS_LEVEL_GROUPS.intermediate;

  if (foundational.includes(level)) return 'foundational';
  if (intermediate.includes(level)) return 'intermediate';
  return 'advanced';
}

/**
 * Course-grounded vs general nursing knowledge (spec H; Playbook §17).
 * course_grounded questions carry chunk provenance and may say "based on
 * your materials"; general_knowledge questions are labeled internally and
 * NEVER attributed to the student's uploads.
