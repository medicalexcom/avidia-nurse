import {
  COGNITIVE_LEVEL_LABELS,
  COGNITIVE_LEVELS,
  CONFIDENCE_LEVEL_LABELS,
  CONFIDENCE_LEVELS,
  isCognitiveLevel,
  isConfidenceLevel,
  isPriorityFramework,
  isQuestionDifficulty,
  isQuestionType,
  PRIORITY_FRAMEWORK_LABELS,
  PRIORITY_FRAMEWORKS,
  QUESTION_DIFFICULTIES,
  QUESTION_DIFFICULTY_LABELS,
  QUESTION_FEEDBACK_REASON_LABELS,
  QUESTION_FEEDBACK_REASONS,
  QUESTION_GENERATION_STATUSES,
  QUESTION_SOURCE_TYPE_LABELS,
  QUESTION_SOURCE_TYPES,
  QUESTION_STATUSES,
  QUESTION_TYPE_LABELS,
  QUESTION_TYPES,
  SESSION_STATUSES,
  SESSION_TYPES,
} from './questions';

describe('question types (M7 spec C)', () => {
  it('covers exactly the reliably scorable interactions', () => {
    expect(QUESTION_TYPES).toEqual([
      'single_best_answer',
      'multiple_response',
      'ordered_response',
      'numeric_calculation',
    ]);
  });

  it('has a student-facing label for every type', () => {
    for (const type of QUESTION_TYPES) {
      expect(QUESTION_TYPE_LABELS[type]).toBeTruthy();
    }
  });

  it('deliberately excludes true/false and free-text interactions', () => {
    expect(isQuestionType('true_false')).toBe(false);
    expect(isQuestionType('free_text')).toBe(false);
    expect(isQuestionType('short_answer')).toBe(false);
  });

  it('type guard accepts controlled values and rejects everything else', () => {
    expect(isQuestionType('single_best_answer')).toBe(true);
    expect(isQuestionType('multiple_response')).toBe(true);
    expect(isQuestionType('mcq')).toBe(false);
    expect(isQuestionType('')).toBe(false);
  });
});

describe('question difficulty (M7 spec F)', () => {
  it('is a coarse three-level metadata scale', () => {
    expect(QUESTION_DIFFICULTIES).toEqual(['easy', 'moderate', 'hard']);
  });

  it('labels every difficulty and guards unknown values', () => {
    for (const difficulty of QUESTION_DIFFICULTIES) {
      expect(QUESTION_DIFFICULTY_LABELS[difficulty]).toBeTruthy();
    }
    expect(isQuestionDifficulty('moderate')).toBe(true);
    expect(isQuestionDifficulty('medium')).toBe(false);
  });
});

describe('cognitive levels (M7 spec E)', () => {
  it('spans recall through prioritization', () => {
    expect(COGNITIVE_LEVELS).toEqual([
      'recall',
      'understanding',
      'application',
      'analysis',
      'prioritization',
    ]);
  });

  it('labels every level and guards unknown values', () => {
    for (const level of COGNITIVE_LEVELS) {
      expect(COGNITIVE_LEVEL_LABELS[level]).toBeTruthy();
    }
    expect(isCognitiveLevel('prioritization')).toBe(true);
    expect(isCognitiveLevel('evaluation')).toBe(false);
  });
});

describe('question source types (M7 spec H)', () => {
  it('separates course-grounded from general nursing knowledge', () => {
    expect(QUESTION_SOURCE_TYPES).toEqual(['course_grounded', 'general_knowledge']);
  });

  it('never labels general knowledge as coming from the student materials', () => {
    expect(QUESTION_SOURCE_TYPE_LABELS.course_grounded).toMatch(/course materials/i);
    expect(QUESTION_SOURCE_TYPE_LABELS.general_knowledge).not.toMatch(/your/i);
  });
});

describe('question lifecycle (M7 spec S)', () => {
  it('models the full generated/active/flagged/rejected/retired lifecycle', () => {
    expect(QUESTION_STATUSES).toEqual(['generated', 'active', 'flagged', 'rejected', 'retired']);
  });
});

describe('confidence scale (M7 spec U)', () => {
  it('is the four-step guessing-to-certain scale', () => {
    expect(CONFIDENCE_LEVELS).toEqual(['guessing', 'unsure', 'pretty_sure', 'certain']);
  });

  it('labels every level and guards unknown values', () => {
    for (const level of CONFIDENCE_LEVELS) {
      expect(CONFIDENCE_LEVEL_LABELS[level]).toBeTruthy();
    }
    expect(isConfidenceLevel('pretty_sure')).toBe(true);
    expect(isConfidenceLevel('sure')).toBe(false);
  });
});

describe('study session lifecycle (M7 spec T)', () => {
  it('models in-progress, completed and abandoned sessions', () => {
    expect(SESSION_STATUSES).toEqual(['in_progress', 'completed', 'abandoned']);
  });

  it('M7 ships practice sessions only', () => {
    expect(SESSION_TYPES).toEqual(['practice']);
  });
});

describe('priority frameworks (M7 spec O)', () => {
  it('covers the nursing prioritization frameworks', () => {
    expect(PRIORITY_FRAMEWORKS).toEqual([
      'abc',
      'safety',
      'acute_vs_chronic',
      'unstable_vs_stable',
      'actual_vs_potential',
      'least_restrictive',
    ]);
  });

  it('labels every framework and guards unknown values', () => {
    for (const framework of PRIORITY_FRAMEWORKS) {
      expect(PRIORITY_FRAMEWORK_LABELS[framework]).toBeTruthy();
    }
    expect(isPriorityFramework('abc')).toBe(true);
    expect(isPriorityFramework('maslow')).toBe(false);
  });
});

describe('question feedback reasons (M7 spec AH)', () => {
  it('offers the controlled flagging reasons with student wording', () => {
    expect(QUESTION_FEEDBACK_REASONS).toEqual([
      'answer_wrong',
      'question_unclear',
      'rationale_unclear',
      'source_mismatch',
      'other',
    ]);
    for (const reason of QUESTION_FEEDBACK_REASONS) {
      expect(QUESTION_FEEDBACK_REASON_LABELS[reason]).toBeTruthy();
    }
  });
});

describe('question generation lifecycle (M7 spec Y)', () => {
  it('is a separate pending/generating/ready/failed document lifecycle', () => {
    expect(QUESTION_GENERATION_STATUSES).toEqual(['pending', 'generating', 'ready', 'failed']);
  });
});
