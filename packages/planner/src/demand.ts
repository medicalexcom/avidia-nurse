/**
 * Course demand queues — M13 (spec E/H/I/J/K/L/Q).
 *
 * Turns the M8/M12 signals for one course into an ORDERED list of candidate
 * activities ("demand items") in triage-tier order (spec Q):
 *
 *   tier 1 — active misconception remediation (urgent confident-error signal)
 *   tier 2 — high-priority exam concepts (M8 ranking order, exam-aware)
 *   tier 3 — due spaced reviews (M8 schedule — never postponed away, spec H)
 *   tier 4 — unassessed exam content → diagnostic coverage blocks (spec I)
 *   tier 5 — higher-order practice + simulation (spec K/L)
 *   tier 6 — enrichment / keep-fresh (repeatable filler)
 *
 * Priorities inside a tier come from M8's ranking ORDER — no second formula.
 */

import { MISCONCEPTION_FACTOR_ACTIVE } from './config';
import {
  COVERAGE_BLOCK_MINUTES,
  ENRICHMENT_MINUTES,
  MAX_COVERAGE_BLOCKS_PER_COURSE,
  MAX_MISCONCEPTION_SLOTS_PER_COURSE,
  MAX_PRIORITY_SLOTS_PER_COURSE,
  MAX_REVIEW_BLOCKS_PER_COURSE,
  MAX_REVIEW_BLOCK_MINUTES,
  MAX_SIMULATIONS_PER_PLAN_PER_COURSE,
  MIN_REVIEW_BLOCK_MINUTES,
  MODE_CHALLENGE_MINUTES,
  MISCONCEPTION_SLOT_MINUTES,
  REVIEW_MINUTES_PER_CONCEPT,
  SIMULATION_MINUTES,
  TARGETED_PRACTICE_MINUTES,
} from './config';
import type { PlanActivityType, PlannerCourseInput, PlanReason } from './types';

export interface DemandItem {
  /** 1 (most urgent) … 6 (enrichment). */
  tier: number;
  type: PlanActivityType;
  conceptId: string | null;
  conceptName: string | null;
  modeId: string | null;
  minutes: number;
  reasons: PlanReason[];
  /** Enrichment items may be scheduled repeatedly (filler). */
  repeatable: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function conceptName(course: PlannerCourseInput, conceptId: string | null): string | null {
  if (conceptId === null) return null;
  return course.conceptNames[conceptId] ?? null;
}

/**
 * Build the ordered demand queue for one course. `daysUntilExamByExamId`
 * lets reasons carry human "exam in N days" context without re-deriving
 * urgency (urgency already shaped the M8 ranking).
 */
export function buildCourseDemand(
  course: PlannerCourseInput,
  daysUntilExamByExamId: ReadonlyMap<string, number>
): DemandItem[] {
  const items: DemandItem[] = [];
  const used = new Set<string>();

  const examReason = (examId: string | null): PlanReason[] => {
    if (examId === null) return [];
    const days = daysUntilExamByExamId.get(examId);
    return [{ code: 'exam_soon', examId, ...(days !== undefined ? { daysUntilExam: days } : {}) }];
  };

  const dueSet = new Set(course.dueReviewConceptIds);

  // tier 1 — misconception remediation (spec J), capped.
  let misconceptionCount = 0;
  for (const rec of course.recommendations) {
    if (misconceptionCount >= MAX_MISCONCEPTION_SLOTS_PER_COURSE) break;
    if (rec.factors.misconceptionMultiplier < MISCONCEPTION_FACTOR_ACTIVE) continue;
    used.add(rec.conceptId);
    misconceptionCount += 1;
    items.push({
      tier: 1,
      type: 'targeted_practice',
      conceptId: rec.conceptId,
      conceptName: conceptName(course, rec.conceptId),
      modeId: null,
      minutes: MISCONCEPTION_SLOT_MINUTES,
      reasons: [{ code: 'misconception_signal' }, ...examReason(rec.urgentExamId)],
      repeatable: false,
    });
  }

  // tier 2 — top M8 priorities (already exam-aware), capped.
  let priorityCount = 0;
  for (const rec of course.recommendations) {
    if (priorityCount >= MAX_PRIORITY_SLOTS_PER_COURSE) break;
    if (used.has(rec.conceptId)) continue;
    used.add(rec.conceptId);
    priorityCount += 1;
    const reasons: PlanReason[] = [];
    if (rec.urgentExamId !== null) reasons.push(...examReason(rec.urgentExamId));
    if (rec.masteryState === 'needs_review' || rec.masteryState === 'developing') {
      reasons.push({ code: 'low_mastery' });
    }
    if (dueSet.has(rec.conceptId)) reasons.push({ code: 'review_due' });
    if (reasons.length === 0) reasons.push({ code: 'keep_fresh' });
    items.push({
      tier: 2,
      type: 'targeted_practice',
      conceptId: rec.conceptId,
      conceptName: conceptName(course, rec.conceptId),
      modeId: null,
      minutes: TARGETED_PRACTICE_MINUTES,
      reasons,
      repeatable: false,
    });
  }

  // tier 3 — due-review blocks (spec H): time RESERVED for M8's schedule.
  const dueCount = course.dueReviewConceptIds.length;
  if (dueCount > 0) {
    const blocks = clamp(Math.ceil(dueCount / 5), 1, MAX_REVIEW_BLOCKS_PER_COURSE);
    const perBlock = clamp(
      Math.round((dueCount * REVIEW_MINUTES_PER_CONCEPT) / blocks),
      MIN_REVIEW_BLOCK_MINUTES,
      MAX_REVIEW_BLOCK_MINUTES
    );
    for (let i = 0; i < blocks; i += 1) {
      items.push({
        tier: 3,
        type: 'due_review',
        conceptId: null,
        conceptName: null,
        modeId: null,
        minutes: perBlock,
        reasons: [{ code: 'review_due' }],
        repeatable: false,
      });
    }
  }

  // tier 4 — coverage diagnostics for unassessed content (spec I): the goal
  // is EVIDENCE, so these are adaptive diagnostic blocks, not judgments.
  const unassessed = course.unassessedConceptIds.length;
  const hasUpcomingExam = course.exams.length > 0;
  if (unassessed > 0) {
    const blocks = hasUpcomingExam
      ? clamp(Math.ceil(unassessed / 8), 1, MAX_COVERAGE_BLOCKS_PER_COURSE)
      : 1;
    const nearestExamId = course.exams[0]?.examId ?? null;
    for (let i = 0; i < blocks; i += 1) {
      items.push({
        tier: hasUpcomingExam ? 4 : 6,
        type: 'start_today',
        conceptId: null,
        conceptName: null,
        modeId: null,
        minutes: COVERAGE_BLOCK_MINUTES,
        reasons: [{ code: 'coverage_gap' }, ...(hasUpcomingExam ? examReason(nearestExamId) : [])],
        repeatable: false,
      });
    }
  }

  // tier 5 — higher-order practice (spec K) using an EXISTING M10 mode.
  if (course.higherOrderGap && course.eligibleModes.includes('who_first')) {
    items.push({
      tier: 5,
      type: 'priority_challenge',
      conceptId: null,
      conceptName: null,
      modeId: 'who_first',
      minutes: MODE_CHALLENGE_MINUTES,
      reasons: [{ code: 'higher_order_gap' }],
      repeatable: false,
    });
  }

  // tier 5 — simulation (spec L): eligibility was gated by the assembler.
  for (
    let i = 0;
    i < (course.simulationAvailable ? MAX_SIMULATIONS_PER_PLAN_PER_COURSE : 0);
    i += 1
  ) {
    items.push({
      tier: 5,
      type: 'simulation',
      conceptId: null,
      conceptName: null,
      modeId: null,
      minutes: SIMULATION_MINUTES,
      reasons: [{ code: 'clinical_practice' }],
      repeatable: false,
    });
  }

  // tier 6 — enrichment filler (repeatable): rapid recall when eligible,
  // otherwise a general adaptive block.
  const rapidEligible = course.eligibleModes.includes('rapid_response');
  items.push({
    tier: 6,
    type: rapidEligible ? 'rapid_response' : 'start_today',
    conceptId: null,
    conceptName: null,
    modeId: rapidEligible ? 'rapid_response' : null,
    minutes: ENRICHMENT_MINUTES,
    reasons: [{ code: 'keep_fresh' }],
    repeatable: true,
  });

  return items.sort((a, b) => a.tier - b.tier);
}

/** Tier-1..5 minutes: the "real" unmet need used for the capacity check. */
export function demandNeedMinutes(items: readonly DemandItem[]): number {
  return items
    .filter((item) => item.tier <= 5 && !item.repeatable)
    .reduce((sum, item) => sum + item.minutes, 0);
}
