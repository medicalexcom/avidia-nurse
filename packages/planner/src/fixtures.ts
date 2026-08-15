/**
 * Deterministic planner fixtures — M13 (spec AX).
 *
 * Builders plus the synthetic scenarios the spec names (cases A-H).
 * Exported from src so every test consumes one canonical dataset; the app
 * bundle never imports this module.
 */

import type { MasteryState } from '@avidia/domain';
import type { StudyRecommendation } from '@avidia/mastery';

import { uniformWeek } from './availability';
import type {
  AvailabilityConfig,
  PlannerCourseInput,
  PlannerExam,
  PlannerInput,
  ReminderPrefs,
} from './types';

/** A fixed reference instant: Friday 2026-08-14 15:00 UTC (11:00 in NY). */
export const FIXED_NOW = new Date('2026-08-14T15:00:00Z');
export const TZ = 'America/New_York';

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${(counter += 1)}`;

/** Reset the id counter so fixture-built datasets are reproducible. */
export function resetFixtureIds(): void {
  counter = 0;
}

export function rec(
  conceptId: string,
  overrides: Partial<StudyRecommendation> = {}
): StudyRecommendation {
  return {
    conceptId,
    priority: 1,
    factors: {
      examRelevance: 1,
      weakness: 0.5,
      forgettingRisk: 0,
      emphasisFactor: 1,
      misconceptionMultiplier: 1,
      transferNeed: 1,
      ...(overrides.factors ?? {}),
    },
    masteryState: (overrides.masteryState ?? 'developing') as MasteryState,
    reasonCodes: overrides.reasonCodes ?? [],
    recommendedQuestionCharacteristics: overrides.recommendedQuestionCharacteristics ?? {
      difficulties: ['moderate'],
      cognitiveLevels: ['application'],
    },
    nextReviewAt: overrides.nextReviewAt ?? null,
    urgentExamId: overrides.urgentExamId ?? null,
    ...(overrides.priority !== undefined ? { priority: overrides.priority } : {}),
  };
}

export function exam(
  courseId: string,
  daysFromNow: number,
  overrides: Partial<PlannerExam> = {}
): PlannerExam {
  return {
    examId: overrides.examId ?? nextId('exam'),
    courseId,
    title: overrides.title ?? 'Exam',
    examAt: new Date(FIXED_NOW.getTime() + daysFromNow * 86_400_000).toISOString(),
    ...overrides,
  };
}

export function course(overrides: Partial<PlannerCourseInput> = {}): PlannerCourseInput {
  const courseId = overrides.courseId ?? nextId('course');
  return {
    courseTitle: 'Adult Health',
    recommendations: [],
    dueReviewConceptIds: [],
    unassessedConceptIds: [],
    conceptNames: {},
    assessedCoverage: 0.8,
    higherOrderGap: false,
    eligibleModes: ['rapid_response', 'who_first'],
    simulationAvailable: false,
    exams: [],
    ...overrides,
    courseId,
  };
}

export function availability(minutesPerDay: number): AvailabilityConfig {
  return { preset: 'custom', minutesByWeekday: uniformWeek(minutesPerDay) };
}

export function input(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    courses: [],
    availability: availability(45),
    timeZone: TZ,
    now: FIXED_NOW,
    ...overrides,
  };
}

export function prefs(overrides: Partial<ReminderPrefs> = {}): ReminderPrefs {
  return {
    studyReminders: true,
    reviewReminders: true,
    examReminders: true,
    reminderHour: 18,
    quietStartHour: 22,
    quietEndHour: 7,
    ...overrides,
  };
}

/** N weak-concept recommendations with names. */
export function weakConcepts(
  count: number,
  options: { examId?: string | null } = {}
): { recommendations: StudyRecommendation[]; conceptNames: Record<string, string> } {
  const recommendations: StudyRecommendation[] = [];
  const conceptNames: Record<string, string> = {};
  for (let i = 1; i <= count; i += 1) {
    const id = `weak-${i}`;
    conceptNames[id] = `Weak concept ${i}`;
    recommendations.push(
      rec(id, {
        priority: 10 - i,
        masteryState: 'needs_review',
        urgentExamId: options.examId ?? null,
      })
    );
  }
  return { recommendations, conceptNames };
}
