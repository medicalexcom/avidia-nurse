/**
 * Course analytics overview — M12 (spec A/D).
 *
 * `getCourseAnalytics(input)` is the single conceptual entry point: the app
 * fetches bounded owner-readable rows, hands them here, and renders the
 * result verbatim. Everything below is composition of the sibling modules —
 * pure, deterministic, LLM-free (spec AN), and answerable to "what should I
 * do next?" rather than corporate BI (spec D).
 */

import { computeCalibration, type CalibrationResult } from './calibration';
import { cognitiveLevelRows, difficultyRows, type CategoryRow } from './categories';
import { computeClinicalJudgment, type ClinicalJudgmentAnalytics } from './clinicalJudgment';
import { computeConceptAnalytics, type ConceptAnalyticsResult } from './conceptAnalytics';
import { computeStudyConsistency, type StudyConsistency } from './consistency';
import { computeDistribution, type DistributionResult } from './distribution';
import { computeErrorPatterns, type ErrorPattern } from './errorPatterns';
import { computeInsights } from './insights';
import {
  computeMedicationAnalytics,
  computeModeAnalytics,
  type MedicationAnalytics,
  type ModeAnalyticsRow,
} from './modes';
import { computeExamReadiness, type ExamReadiness } from './readiness';
import { computeSimulationAnalytics, type SimulationAnalytics } from './simulationAnalytics';
import { classifyTrend, type TrendResult } from './trend';
import { splitWeekOverWeek } from './windows';
import type { AnalyticsInput, Insight } from './types';
import type { CognitiveLevel, QuestionDifficulty } from '@avidia/domain';

export interface CourseAnalytics {
  distribution: DistributionResult;
  conceptAnalytics: ConceptAnalyticsResult;
  /** Course-wide accuracy trend, this week vs previous week (spec C/G). */
  weekOverWeek: TrendResult;
  cognitiveLevels: CategoryRow<CognitiveLevel>[];
  difficulties: CategoryRow<QuestionDifficulty>[];
  calibration: CalibrationResult;
  readiness: ExamReadiness;
  consistency: StudyConsistency;
  modes: ModeAnalyticsRow[];
  medication: MedicationAnalytics;
  clinicalJudgment: ClinicalJudgmentAnalytics;
  simulation: SimulationAnalytics;
  errorPatterns: ErrorPattern[];
  insights: Insight[];
  /** True when the course has no attempts at all (spec AI empty state). */
  isEmpty: boolean;
}

export function getCourseAnalytics(input: AnalyticsInput): CourseAnalytics {
  const { attempts, mastery, concepts, sessions, exams, simulations, timeZone, now } = input;

  const distribution = computeDistribution(concepts, mastery, now);
  const conceptAnalytics = computeConceptAnalytics(concepts, mastery, attempts, now, timeZone);
  const { thisWeek, previousWeek } = splitWeekOverWeek(attempts, now, timeZone);
  const weekOverWeek = classifyTrend(thisWeek, previousWeek);
  const calibration = computeCalibration(attempts);
  const readiness = computeExamReadiness(concepts, mastery, attempts, exams, now, timeZone);
  const consistency = computeStudyConsistency(attempts, sessions, now, timeZone);
  const modes = computeModeAnalytics(attempts, sessions);
  const medication = computeMedicationAnalytics(attempts, concepts);
  const clinicalJudgment = computeClinicalJudgment(attempts, simulations);
  const simulation = computeSimulationAnalytics(simulations);
  const errorPatterns = computeErrorPatterns(attempts);
  const insights = computeInsights({
    conceptAnalytics,
    calibration,
    errorPatterns,
    simulation,
    consistency,
    dueForReviewCount: distribution.distribution.due_for_review,
  });

  return {
    distribution,
    conceptAnalytics,
    weekOverWeek,
    cognitiveLevels: cognitiveLevelRows(attempts),
    difficulties: difficultyRows(attempts),
    calibration,
    readiness,
    consistency,
    modes,
    medication,
    clinicalJudgment,
    simulation,
    errorPatterns,
    insights,
    isEmpty: attempts.length === 0 && simulations.length === 0,
  };
}
