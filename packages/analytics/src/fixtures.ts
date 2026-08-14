/**
 * Deterministic test fixtures — M12 (spec AS).
 *
 * Builders plus the five synthetic students the spec names:
 *   A — strong recall, weak prioritization
 *   B — high accuracy but only ~30% of concepts covered
 *   C — repeatedly certain AND incorrect on one concept (misconception)
 *   D — simulations: recognizes cues well, fails reassessment
 *   E — enrolled, zero attempts
 *
 * Exported from src so tests import one canonical dataset; excluded from
 * the app bundle by simply not being imported there.
 */

import type { CognitiveLevel, QuestionDifficulty } from '@avidia/domain';
import type { MasteryAggregate } from '@avidia/mastery';
import type {
  AnalyticsInput,
  AttemptRecord,
  ConceptRecord,
  ExamRecord,
  MasteryRecord,
  SessionRecord,
  SimulationRecord,
} from './types';

export const FIXED_NOW = new Date('2026-08-14T15:00:00Z');
export const TZ = 'America/New_York';

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, '0')}`;
}

/** Reset the id counter so each test file starts deterministic. */
export function resetFixtureIds(): void {
  counter = 0;
}

export function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    attemptId: nextId('att'),
    questionId: nextId('q'),
    conceptId: 'c-1',
    isCorrect: true,
    confidence: null,
    difficulty: 'moderate' as QuestionDifficulty,
    cognitiveLevel: 'recall' as CognitiveLevel,
    questionType: 'sba',
    sessionType: 'practice',
    createdAt: '2026-08-14T12:00:00Z',
    ...overrides,
  };
}

export function concept(overrides: Partial<ConceptRecord> = {}): ConceptRecord {
  const id = overrides.conceptId ?? nextId('c');
  return {
    conceptId: id,
    canonicalName: overrides.canonicalName ?? `Concept ${id}`,
    conceptType: 'condition',
    emphasisScore: 1,
    ...overrides,
  };
}

export function aggregate(overrides: Partial<MasteryAggregate> = {}): MasteryAggregate {
  return {
    mastery: 0.5,
    attemptsCount: 5,
    correctCount: 3,
    misconceptionSeverity: 0,
    reviewStage: 1,
    lastAttemptAt: '2026-08-13T12:00:00Z',
    nextReviewAt: '2026-08-20T12:00:00Z',
    ...overrides,
  };
}

export function masteryRecord(
  conceptId: string,
  overrides: Partial<MasteryAggregate> = {}
): MasteryRecord {
  return { conceptId, aggregate: aggregate(overrides) };
}

export function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: nextId('s'),
    sessionType: 'practice',
    status: 'completed',
    startedAt: '2026-08-14T11:00:00Z',
    completedAt: '2026-08-14T11:20:00Z',
    attemptCount: 5,
    ...overrides,
  };
}

export function exam(overrides: Partial<ExamRecord> = {}): ExamRecord {
  return {
    examId: nextId('exam'),
    title: 'Med-Surg Exam 2',
    examAt: '2026-08-28T13:00:00Z',
    ...overrides,
  };
}

export function simulation(overrides: Partial<SimulationRecord> = {}): SimulationRecord {
  return {
    sessionId: nextId('sim'),
    caseKey: 'postop_pe',
    caseTitle: 'Post-op day 2 — sudden dyspnea',
    outcomeKind: 'stabilized',
    outcomeLabel: 'Patient stabilized',
    completedAt: '2026-08-13T18:00:00Z',
    earned: 10,
    possible: 16,
    criticalMissedCount: 0,
    unsafeActionCount: 0,
    dimensions: [
      { dimension: 'recognize_cues', label: 'Recognize cues', earned: 3, possible: 4 },
      { dimension: 'evaluate_outcomes', label: 'Evaluate outcomes', earned: 1, possible: 4 },
    ],
    ...overrides,
  };
}

export function input(overrides: Partial<AnalyticsInput> = {}): AnalyticsInput {
  return {
    attempts: [],
    mastery: [],
    concepts: [],
    sessions: [],
    exams: [],
    simulations: [],
    timeZone: TZ,
    now: FIXED_NOW,
    ...overrides,
  };
}

/** Days-ago helper anchored to FIXED_NOW (UTC instant arithmetic). */
export function daysAgo(days: number, hoursOffset = 0): string {
  return new Date(FIXED_NOW.getTime() - days * 86400_000 - hoursOffset * 3600_000).toISOString();
}

// ---------------------------------------------------------------------------
// Synthetic students (spec AS)
// ---------------------------------------------------------------------------

const TEN_CONCEPTS: ConceptRecord[] = Array.from({ length: 10 }, (_, i) =>
  concept({ conceptId: `c-${i + 1}`, canonicalName: `Concept ${i + 1}`, emphasisScore: 1 })
);

/** A — strong recall, weak prioritization. */
export function studentA(): AnalyticsInput {
  const attempts: AttemptRecord[] = [];
  for (let i = 0; i < 12; i += 1) {
    attempts.push(
      attempt({
        conceptId: `c-${(i % 5) + 1}`,
        cognitiveLevel: 'recall',
        isCorrect: i !== 0, // 11/12 recall correct
        createdAt: daysAgo(i % 6, i),
      })
    );
  }
  for (let i = 0; i < 8; i += 1) {
    attempts.push(
      attempt({
        conceptId: `c-${(i % 5) + 1}`,
        cognitiveLevel: 'prioritization',
        isCorrect: i >= 6, // 2/8 prioritization correct
        createdAt: daysAgo(i % 6, 12 + i),
      })
    );
  }
  const mastery = [1, 2, 3, 4, 5].map((i) =>
    masteryRecord(`c-${i}`, {
      mastery: 0.6,
      attemptsCount: 4,
      correctCount: 3,
      nextReviewAt: daysAgo(-7),
    })
  );
  return input({ concepts: TEN_CONCEPTS, attempts, mastery });
}

/** B — high accuracy but only 3 of 10 concepts covered (spec O/Q gate). */
export function studentB(): AnalyticsInput {
  const attempts: AttemptRecord[] = [];
  for (let i = 0; i < 24; i += 1) {
    attempts.push(
      attempt({
        conceptId: `c-${(i % 3) + 1}`,
        isCorrect: i % 12 !== 0, // ~92% accurate
        cognitiveLevel: i % 2 === 0 ? 'recall' : 'application',
        createdAt: daysAgo(i % 10, i),
      })
    );
  }
  const mastery = [1, 2, 3].map((i) =>
    masteryRecord(`c-${i}`, {
      mastery: 0.9,
      attemptsCount: 8,
      correctCount: 7,
      nextReviewAt: daysAgo(-10),
    })
  );
  return input({ concepts: TEN_CONCEPTS, attempts, mastery, exams: [exam()] });
}

/** C — repeated certain-and-incorrect on one concept (misconception). */
export function studentC(): AnalyticsInput {
  const attempts: AttemptRecord[] = [];
  for (let i = 0; i < 6; i += 1) {
    attempts.push(
      attempt({
        conceptId: 'c-1',
        isCorrect: false,
        confidence: 'certain',
        createdAt: daysAgo(i, i),
      })
    );
  }
  for (let i = 0; i < 8; i += 1) {
    attempts.push(
      attempt({
        conceptId: 'c-2',
        isCorrect: true,
        confidence: 'pretty_sure',
        createdAt: daysAgo(i % 4, 6 + i),
      })
    );
  }
  const mastery = [
    masteryRecord('c-1', {
      mastery: 0.2,
      attemptsCount: 6,
      correctCount: 0,
      misconceptionSeverity: 0.7,
      nextReviewAt: daysAgo(-1),
    }),
    masteryRecord('c-2', {
      mastery: 0.8,
      attemptsCount: 8,
      correctCount: 7,
      nextReviewAt: daysAgo(-5),
    }),
  ];
  return input({ concepts: TEN_CONCEPTS, attempts, mastery });
}

/** D — simulations: cue recognition strong, reassessment weak. */
export function studentD(): AnalyticsInput {
  const sims = [0, 1, 2].map((i) =>
    simulation({
      completedAt: daysAgo(6 - i * 2),
      outcomeKind: i === 0 ? 'deteriorated' : 'stabilized',
      earned: 8 + i,
      possible: 16,
      criticalMissedCount: i === 0 ? 1 : 0,
      unsafeActionCount: 0,
      dimensions: [
        { dimension: 'recognize_cues', label: 'Recognize cues', earned: 4, possible: 4 },
        { dimension: 'evaluate_outcomes', label: 'Evaluate outcomes', earned: 0, possible: 4 },
      ],
    })
  );
  return input({ concepts: TEN_CONCEPTS, simulations: sims });
}

/** E — enrolled, zero attempts (spec AI empty state). */
export function studentE(): AnalyticsInput {
  return input({ concepts: TEN_CONCEPTS, exams: [exam()] });
}
