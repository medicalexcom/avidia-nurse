/**
 * Plan generation — M13 (spec D/E/F/N/P/Q/R/S/T).
 *
 * Deterministic allocation of demand items into daily budgets:
 *
 *   1. Horizon = today … today + horizonDays - 1 (local calendar days).
 *   2. Each day's budget comes from configured availability (spec D).
 *   3. Each course keeps a demand queue (triage-tier order, see demand.ts).
 *   4. A day's budget is split across courses proportionally to a weight of
 *      exam urgency (M8's examUrgency — no second formula) plus an unmet-
 *      coverage boost (spec F: don't starve an exam with unmet coverage),
 *      using largest-remainder so the split is deterministic and exact.
 *   5. Courses fill their share from their queue; an item whose concept was
 *      already scheduled that day is deferred to a later day (spec J).
 *   6. Days are never overfilled (spec P); if tier-1..5 need exceeds the
 *      capacity before the earliest exam, the result says so honestly
 *      instead of silently compressing five hours into two.
 *
 * RECALCULATION IS REGENERATION (spec R/S/T): callers re-assemble fresh
 * inputs (updated mastery, exams, availability, completed work) and call
 * createStudyPlan again; generation always starts at "today", so a missed
 * Tuesday is never "moved to Wednesday" — remaining priorities are simply
 * replanned against the remaining days.
 */

import { calendarDateInZone } from '@avidia/domain';
import { examUrgency } from '@avidia/mastery';

import {
  COURSE_BASE_WEIGHT,
  COURSE_COVERAGE_BOOST,
  COURSE_URGENCY_WEIGHT,
  DEFAULT_HORIZON_DAYS,
  PLANNER_RULES_VERSION,
  SIMULATION_MINUTES,
} from './config';
import { minutesForWeekday } from './availability';
import { buildCourseDemand, demandNeedMinutes, type DemandItem } from './demand';
import { addDays, dateKey, localDaysUntil, weekdayOf } from './dates';
import type {
  PlanDay,
  PlannedActivitySpec,
  PlannerCourseInput,
  PlannerInput,
  StudyPlanResult,
} from './types';

interface CourseState {
  course: PlannerCourseInput;
  queue: DemandItem[];
  needMinutes: number;
}

/** Largest-remainder split of `total` proportional to `weights` (exact). */
export function splitBudget(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let remaining = total - floors.reduce((a, b) => a + b, 0);
  // Distribute the remainder to the largest fractional parts; ties break by
  // index so the split is fully deterministic.
  const order = raw
    .map((r, i) => ({ frac: r - Math.floor(r), i }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = [...floors];
  for (const { i } of order) {
    if (remaining <= 0) break;
    out[i] = (out[i] ?? 0) + 1;
    remaining -= 1;
  }
  return out;
}

function toActivity(course: PlannerCourseInput, item: DemandItem): PlannedActivitySpec {
  return {
    courseId: course.courseId,
    courseTitle: course.courseTitle,
    type: item.type,
    conceptId: item.conceptId,
    conceptName: item.conceptName,
    modeId: item.modeId,
    minutes: item.minutes,
    reasons: item.reasons,
  };
}

export function createStudyPlan(input: PlannerInput): StudyPlanResult {
  const { courses, availability, timeZone, now } = input;
  const horizonDays = Math.max(1, input.horizonDays ?? DEFAULT_HORIZON_DAYS);
  const startDate = calendarDateInZone(now, timeZone);

  // Local days-until for every exam, for weighting and reasons.
  const daysUntilByExam = new Map<string, number>();
  let earliestExamDay: number | null = null;
  for (const course of courses) {
    for (const exam of course.exams) {
      const days = localDaysUntil(exam.examAt, now, timeZone);
      if (days === null || days < 0) continue; // past exams contribute nothing (spec X)
      daysUntilByExam.set(exam.examId, days);
      if (earliestExamDay === null || days < earliestExamDay) earliestExamDay = days;
    }
  }

  const states: CourseState[] = [...courses]
    .sort((a, b) => a.courseId.localeCompare(b.courseId))
    .map((course) => {
      const queue = buildCourseDemand(course, daysUntilByExam);
      return { course, queue, needMinutes: demandNeedMinutes(queue) };
    });

  const totalNeedMinutes = states.reduce((sum, s) => sum + s.needMinutes, 0);

  const days: PlanDay[] = [];
  for (let dayIndex = 0; dayIndex < horizonDays; dayIndex += 1) {
    const date = addDays(startDate, dayIndex);
    const key = dateKey(date);
    const weekday = weekdayOf(date);
    const budget = minutesForWeekday(availability, weekday);
    // A synthetic instant inside the plan day, for urgency-at-that-day; the
    // day math itself is calendar-based so DST wobble cannot shift the day.
    const dayInstant = new Date(now.getTime() + dayIndex * 86_400_000);

    const examIds: string[] = [];
    for (const [examId, examDay] of daysUntilByExam) {
      if (examDay === dayIndex) examIds.push(examId);
    }
    examIds.sort();

    const activities: PlannedActivitySpec[] = [];
    let planned = 0;

    if (budget > 0) {
      const conceptsToday = new Set<string>();

      // Course weights for THIS day (spec F).
      const weights = states.map((state) => {
        if (state.queue.every((item) => item.repeatable)) return 0.0001; // enrichment only
        let urgency = 0;
        for (const exam of state.course.exams) {
          const u = examUrgency(exam, dayInstant, timeZone);
          if (u !== null && u > urgency) urgency = u;
        }
        const coverageUnmet =
          state.course.unassessedConceptIds.length > 0 && state.course.exams.length > 0;
        return (
          COURSE_BASE_WEIGHT +
          COURSE_URGENCY_WEIGHT * urgency +
          (coverageUnmet ? COURSE_COVERAGE_BOOST : 0)
        );
      });

      const shares = splitBudget(budget, weights);

      const fillFromCourse = (state: CourseState, allowance: number): number => {
        let remaining = allowance;
        let index = 0;
        while (index < state.queue.length && remaining > 0) {
          const item = state.queue[index]!;
          const conceptClash = item.conceptId !== null && conceptsToday.has(item.conceptId);
          const simTooBig =
            item.type === 'simulation' && (budget < SIMULATION_MINUTES || remaining < item.minutes);
          if (conceptClash || simTooBig || item.minutes > remaining) {
            index += 1; // deferred: stays queued for a later day
            continue;
          }
          activities.push(toActivity(state.course, item));
          if (item.conceptId !== null) conceptsToday.add(item.conceptId);
          remaining -= item.minutes;
          if (item.repeatable) {
            index += 1; // keep it in the queue but don't loop it within a day
          } else {
            state.queue.splice(index, 1);
          }
        }
        return allowance - remaining;
      };

      // Fill each course's share (stable course order), then hand leftover
      // minutes to the remaining courses in a second pass.
      states.forEach((state, i) => {
        planned += fillFromCourse(state, shares[i] ?? 0);
      });
      let leftover = budget - planned;
      for (const state of states) {
        if (leftover <= 0) break;
        const usedNow = fillFromCourse(state, leftover);
        planned += usedNow;
        leftover -= usedNow;
      }
    }

    days.push({
      date: key,
      weekday,
      availableMinutes: budget,
      plannedMinutes: planned,
      activities,
      examIds,
    });
  }

  // Capacity before the earliest exam (or the whole horizon) — spec P.
  const capacityDays =
    earliestExamDay === null ? horizonDays : Math.min(earliestExamDay, horizonDays);
  let capacityMinutes = 0;
  for (let i = 0; i < Math.max(capacityDays, 1); i += 1) {
    capacityMinutes += minutesForWeekday(availability, weekdayOf(addDays(startDate, i)));
  }

  const totalPlannedMinutes = days.reduce((sum, d) => sum + d.plannedMinutes, 0);
  const lastDay = days[days.length - 1];

  return {
    days,
    horizonStart: dateKey(startDate),
    horizonEnd: lastDay ? lastDay.date : dateKey(startDate),
    totalPlannedMinutes,
    totalNeedMinutes,
    capacityMinutes,
    overCapacity: totalNeedMinutes > capacityMinutes,
    rulesVersion: PLANNER_RULES_VERSION,
  };
}

/** Today's slice of a generated plan (spec V). */
export function getTodayPlan(plan: StudyPlanResult): PlanDay | null {
  return plan.days[0] ?? null;
}

/** The next `count` days AFTER today (spec W). */
export function getUpcomingPlan(plan: StudyPlanResult, count = 6): PlanDay[] {
  return plan.days.slice(1, 1 + count);
}
