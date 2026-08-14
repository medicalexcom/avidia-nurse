/**
 * Simulated-student and property tests — M8 (spec AK).
 *
 * Each simulated student replays a scripted attempt history through the
 * pure engine and asserts the qualitative outcome the algorithm must
 * produce. Invariant checks run across every simulation step.
 */

import { rankConcepts, type ConceptSnapshot } from './recommend';
import { masteryState } from './states';
import {
  hasMisconceptionSignal,
  initialAggregate,
  updateMastery,
  type MasteryAggregate,
  type PerformanceEvent,
} from './update';
import { DROP_CAP, GAIN_CAP } from './config';

const START = Date.parse('2026-08-01T12:00:00.000Z');
const HOUR = 3600_000;

function replay(
  events: Array<Partial<PerformanceEvent>>,
  gapHours = 1
): { aggregate: MasteryAggregate; deltas: number[] } {
  let aggregate = initialAggregate();
  const deltas: number[] = [];
  events.forEach((overrides, i) => {
    const event: PerformanceEvent = {
      isCorrect: true,
      difficulty: 'moderate',
      cognitiveLevel: 'application',
      confidence: null,
      answeredAt: new Date(START + i * gapHours * HOUR).toISOString(),
      ...overrides,
    };
    const result = updateMastery(aggregate, event);
    // Invariants on EVERY step (spec AK): bounded, capped, finite.
    expect(result.aggregate.mastery).toBeGreaterThanOrEqual(0);
    expect(result.aggregate.mastery).toBeLessThanOrEqual(1);
    expect(Number.isFinite(result.aggregate.mastery)).toBe(true);
    expect(Math.abs(result.masteryDelta)).toBeLessThanOrEqual(Math.max(GAIN_CAP, DROP_CAP));
    expect(result.aggregate.misconceptionSeverity).toBeGreaterThanOrEqual(0);
    expect(result.aggregate.misconceptionSeverity).toBeLessThanOrEqual(1);
    deltas.push(result.masteryDelta);
    aggregate = result.aggregate;
  });
  return { aggregate, deltas };
}

describe('simulated students (spec AK)', () => {
  it('A: ten correct confident answers → mastery rises to strong', () => {
    const { aggregate } = replay(
      Array.from({ length: 10 }, () => ({ confidence: 'pretty_sure' as const }))
    );
    expect(aggregate.mastery).toBeGreaterThanOrEqual(0.75);
    expect(masteryState(aggregate, new Date(START + 11 * HOUR))).toBe('strong');
  });

  it('B: ten incorrect answers → mastery stays low', () => {
    const { aggregate } = replay(
      Array.from({ length: 10 }, () => ({ isCorrect: false, confidence: 'unsure' as const }))
    );
    expect(aggregate.mastery).toBeLessThan(0.4);
    expect(masteryState(aggregate, new Date(START + 11 * HOUR))).toBe('needs_review');
  });

  it('C: correct answers while guessing → mastery rises cautiously (spec H)', () => {
    const guessing = replay(
      Array.from({ length: 10 }, () => ({ confidence: 'guessing' as const }))
    );
    const confident = replay(
      Array.from({ length: 10 }, () => ({ confidence: 'pretty_sure' as const }))
    );
    expect(guessing.aggregate.mastery).toBeGreaterThan(0); // still progress
    expect(guessing.aggregate.mastery).toBeLessThan(confident.aggregate.mastery);
    // and a short run of lucky guesses cannot claim strength (a long run of
    // correct answers IS evidence, even self-doubting — spec H never
    // punishes honesty, it only slows the climb):
    const fiveGuesses = replay(
      Array.from({ length: 5 }, () => ({ confidence: 'guessing' as const }))
    );
    expect(fiveGuesses.aggregate.mastery).toBeLessThan(0.75);
    // lucky guesses also never advance the review schedule:
    expect(guessing.aggregate.reviewStage).toBe(0);
  });

  it('D: repeated confident-incorrect → low mastery AND misconception signal (spec R)', () => {
    const { aggregate } = replay(
      Array.from({ length: 4 }, () => ({ isCorrect: false, confidence: 'certain' as const }))
    );
    expect(aggregate.mastery).toBeLessThan(0.4);
    expect(hasMisconceptionSignal(aggregate.misconceptionSeverity)).toBe(true);
  });

  it('E: strong 30 days ago → evidence stays strong, urgency is review-due (spec J)', () => {
    const { aggregate } = replay(
      Array.from({ length: 10 }, () => ({ confidence: 'certain' as const }))
    );
    expect(aggregate.mastery).toBeGreaterThanOrEqual(0.75);
    const thirtyDaysLater = new Date(Date.parse(aggregate.lastAttemptAt!) + 31 * 24 * HOUR);
    expect(masteryState(aggregate, thirtyDaysLater)).toBe('due_for_review');
    // The mastery number itself did NOT decay — urgency and evidence are separate.
    expect(aggregate.mastery).toBeGreaterThanOrEqual(0.75);
  });

  it('F: weak concept with exam tomorrow gets very high priority (spec L)', () => {
    const weak = replay(
      Array.from({ length: 4 }, () => ({ isCorrect: false, confidence: 'unsure' as const }))
    ).aggregate;
    const now = new Date('2026-08-13T12:00:00.000Z');
    const snapshot = (id: string): ConceptSnapshot => ({
      conceptId: id,
      aggregate: weak,
      normalizedEmphasis: 0.3,
      hasHigherOrderCorrect: false,
      lastIncorrectAt: weak.lastAttemptAt,
      unseenQuestionCount: 10,
    });
    const withExam = rankConcepts({
      concepts: [snapshot('c1')],
      exams: [{ examId: 'e1', examAt: '2026-08-14T14:00:00.000Z' }],
      timeZone: 'America/Chicago',
      now,
    })[0];
    const withoutExam = rankConcepts({
      concepts: [snapshot('c1')],
      exams: [],
      timeZone: 'America/Chicago',
      now,
    })[0];
    expect(withExam!.priority).toBeGreaterThan(2 * withoutExam!.priority);
    expect(withExam!.reasonCodes).toEqual(expect.arrayContaining(['low_mastery', 'exam_soon']));
  });

  it('G: weakness NOT on any exam ranks below an equal weakness that is (spec AK G)', () => {
    const weak = replay(
      Array.from({ length: 4 }, () => ({ isCorrect: false, confidence: 'unsure' as const }))
    ).aggregate;
    const now = new Date('2026-08-13T12:00:00.000Z');
    const snapshot = (id: string): ConceptSnapshot => ({
      conceptId: id,
      aggregate: weak,
      normalizedEmphasis: 0.3,
      hasHigherOrderCorrect: false,
      lastIncorrectAt: null,
      unseenQuestionCount: 10,
    });
    const ranked = rankConcepts({
      concepts: [snapshot('not-on-exam'), snapshot('on-exam')],
      exams: [{ examId: 'e1', examAt: '2026-08-14T14:00:00.000Z', conceptIds: ['on-exam'] }],
      timeZone: 'America/Chicago',
      now,
    });
    expect(ranked[0]!.conceptId).toBe('on-exam');
    expect(ranked[1]!.conceptId).toBe('not-on-exam');
    // ...but the non-exam weakness is still surfaced, not zeroed:
    expect(ranked[1]!.priority).toBeGreaterThan(0);
  });

  it('property: alternating correct/incorrect never leaves bounds over 200 steps', () => {
    const events = Array.from({ length: 200 }, (_, i) => ({
      isCorrect: i % 2 === 0,
      confidence: (['guessing', 'unsure', 'pretty_sure', 'certain'] as const)[i % 4],
      difficulty: (['easy', 'moderate', 'hard'] as const)[i % 3],
      cognitiveLevel: (
        ['recall', 'understanding', 'application', 'analysis', 'prioritization'] as const
      )[i % 5],
    }));
    const { aggregate } = replay(events);
    expect(aggregate.attemptsCount).toBe(200);
    expect(aggregate.correctCount).toBe(100);
  });

  it('property: replay is order-deterministic (same history twice, spec AB)', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      isCorrect: i % 3 !== 0,
      confidence: (['unsure', 'certain', null] as const)[i % 3],
    }));
    expect(replay(history).aggregate).toEqual(replay(history).aggregate);
  });
});
