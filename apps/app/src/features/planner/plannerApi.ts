import type { SupabaseClient } from '@supabase/supabase-js';

import { cognitiveLevelRows } from '@avidia/analytics';
import { rankConcepts } from '@avidia/mastery';
import {
  HIGHER_ORDER_GAP_ACCURACY,
  availabilityFromPreset,
  matchSessionsToActivities,
  normalizeWeek,
  type AvailabilityConfig,
  type AvailabilityPreset,
  type CompletedSessionLike,
  type MatchableActivity,
  type PlanActivityStatus,
  type PlanActivityType,
  type PlanReason,
  type PlannerCourseInput,
  type ReminderPrefs,
  type StudyPlanResult,
} from '@avidia/planner';

import { listAnalyticsAttempts } from '../analytics/analyticsApi';
import { listConcepts } from '../concepts/conceptsApi';
import type { CourseSummary } from '../courses/coursesApi';
import { modeAvailability } from '../modes/registry';
import { listActiveQuestions } from '../practice/practiceApi';
import { listSimulationCases } from '../simulation/simulationApi';
import {
  buildConceptSnapshots,
  listConceptMastery,
  listCourseAttempts,
  listCourseExams,
  toUpcomingExams,
} from '../study/studyApi';
import { dueReviewConceptIds } from '../today/plan';

/**
 * Data plumbing for the study planner — M13 (spec A/G/AL/AN/AT).
 *
 * This module ONLY moves data: every scheduling decision lives in the pure
 * `@avidia/planner` engine (spec A/N), every mastery signal comes from M8
 * ranking and every analytics signal from M12 building blocks. Persistence is
 * RPC-only (spec AL/AO); reads are plain RLS-scoped selects.
 */

// ---------------------------------------------------------------------------
// Planner settings (spec B/AB)
// ---------------------------------------------------------------------------

export interface PlannerSettings {
  availability: AvailabilityConfig;
  reminders: ReminderPrefs;
}

interface PlannerSettingsRow {
  preset: AvailabilityPreset;
  minutes_by_weekday: number[];
  study_reminders: boolean;
  review_reminders: boolean;
  exam_reminders: boolean;
  reminder_hour: number;
  quiet_start_hour: number;
  quiet_end_hour: number;
}

/** Conservative defaults: standard availability, ALL reminders off (spec AB). */
export function defaultPlannerSettings(): PlannerSettings {
  return {
    availability: availabilityFromPreset('standard'),
    reminders: {
      studyReminders: false,
      reviewReminders: false,
      examReminders: false,
      reminderHour: 18,
      quietStartHour: 22,
      quietEndHour: 7,
    },
  };
}

export async function fetchPlannerSettings(
  client: SupabaseClient,
  userId: string
): Promise<PlannerSettings> {
  const { data, error } = await client
    .from('planner_settings')
    .select(
      'preset, minutes_by_weekday, study_reminders, review_reminders, exam_reminders, ' +
        'reminder_hour, quiet_start_hour, quiet_end_hour'
    )
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return defaultPlannerSettings();
  const row = data as unknown as PlannerSettingsRow;
  return {
    availability: { preset: row.preset, minutesByWeekday: normalizeWeek(row.minutes_by_weekday) },
    reminders: {
      studyReminders: row.study_reminders,
      reviewReminders: row.review_reminders,
      examReminders: row.exam_reminders,
      reminderHour: row.reminder_hour,
      quietStartHour: row.quiet_start_hour,
      quietEndHour: row.quiet_end_hour,
    },
  };
}

export async function savePlannerSettings(
  client: SupabaseClient,
  userId: string,
  settings: PlannerSettings
): Promise<void> {
  const { error } = await client.from('planner_settings').upsert({
    user_id: userId,
    preset: settings.availability.preset,
    minutes_by_weekday: [...settings.availability.minutesByWeekday],
    study_reminders: settings.reminders.studyReminders,
    review_reminders: settings.reminders.reviewReminders,
    exam_reminders: settings.reminders.examReminders,
    reminder_hour: settings.reminders.reminderHour,
    quiet_start_hour: settings.reminders.quietStartHour,
    quiet_end_hour: settings.reminders.quietEndHour,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Planner input assembly (spec G/I/K/L — course-scoped reads, cross-course plan)
// ---------------------------------------------------------------------------

/**
 * Assemble one course's planner input from the SAME sources the rest of the
 * app uses: M8 ranking for priorities/due reviews, M12 category rows for the
 * higher-order gap, the M10 registry for mode eligibility, and the M11 case
 * library for simulation availability. Nothing here re-scores anything.
 */
export async function loadPlannerCourseInput(
  client: SupabaseClient,
  course: Pick<CourseSummary, 'id' | 'title'>,
  timeZone: string,
  now: Date,
  simulationCaseCount: number
): Promise<PlannerCourseInput> {
  const [concepts, questions, mastery, attempts, exams, analyticsAttempts] = await Promise.all([
    listConcepts(client, course.id),
    listActiveQuestions(client, course.id),
    listConceptMastery(client, course.id),
    listCourseAttempts(client, course.id),
    listCourseExams(client, course.id),
    listAnalyticsAttempts(client, course.id),
  ]);

  const snapshots = buildConceptSnapshots(concepts, questions, mastery, attempts);
  const recommendations = rankConcepts({
    concepts: snapshots,
    exams: toUpcomingExams(exams),
    timeZone,
    now,
  });

  // UNASSESSED ≠ WEAK (spec I): concepts with no attempt evidence at all.
  const assessed = new Set(
    mastery.filter((row) => row.attempts_count > 0).map((row) => row.concept_id)
  );
  const unassessedConceptIds = concepts.filter((c) => !assessed.has(c.id)).map((c) => c.id);
  const assessedCoverage = concepts.length === 0 ? 0 : assessed.size / concepts.length;

  // Higher-order gap (spec K): M12's cognitive-level rows, M12's threshold —
  // no new statistics invented here.
  const higherOrderGap = cognitiveLevelRows(analyticsAttempts).some(
    (row) =>
      (row.key === 'application' || row.key === 'analysis') &&
      row.accuracy?.accuracy != null &&
      row.accuracy.accuracy < HIGHER_ORDER_GAP_ACCURACY
  );

  const eligibleModes = modeAvailability(
    questions.map((question) => ({
      id: question.id,
      conceptId: question.concept_id,
      questionType: question.question_type,
      difficulty: question.difficulty,
      cognitiveLevel: question.cognitive_level,
      priorityFrameworks: question.priority_frameworks,
    })),
    new Map(concepts.map((concept) => [concept.id, concept.concept_type]))
  )
    .filter((entry) => entry.eligible)
    .map((entry) => entry.mode.id);

  return {
    courseId: course.id,
    courseTitle: course.title,
    recommendations,
    dueReviewConceptIds: [...dueReviewConceptIds(mastery, now)],
    unassessedConceptIds,
    conceptNames: Object.fromEntries(concepts.map((c) => [c.id, c.canonical_name])),
    assessedCoverage,
    higherOrderGap,
    eligibleModes,
    simulationAvailable: simulationCaseCount > 0 && questions.length > 0,
    exams: exams.map((exam) => ({
      examId: exam.id,
      courseId: course.id,
      title: exam.title,
      examAt: exam.exam_at,
    })),
  };
}

/** The shared M11 case library gates simulation activities (spec L). */
export async function countSimulationCases(client: SupabaseClient): Promise<number> {
  try {
    const cases = await listSimulationCases(client);
    return cases.length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Plan persistence (spec AL/AM/AO — RPC-only writes)
// ---------------------------------------------------------------------------

export interface StoredPlanRow {
  id: string;
  revision: number;
  horizon_start: string;
  horizon_end: string;
  time_zone: string;
  total_planned_minutes: number;
  total_need_minutes: number;
  capacity_minutes: number;
  over_capacity: boolean;
  created_at: string;
}

export interface StoredActivityRow {
  id: string;
  course_id: string;
  activity_date: string;
  position: number;
  activity_type: PlanActivityType;
  concept_id: string | null;
  mode_id: string | null;
  minutes: number;
  reasons: PlanReason[];
  status: PlanActivityStatus;
  session_id: string | null;
  simulation_session_id: string | null;
}

export interface StoredPlan {
  plan: StoredPlanRow;
  activities: StoredActivityRow[];
}

/** Persist a freshly generated plan; the RPC supersedes the old revision. */
export async function saveStudyPlan(
  client: SupabaseClient,
  result: StudyPlanResult,
  timeZone: string
): Promise<string> {
  const activities = result.days.flatMap((day) =>
    day.activities.map((activity, index) => ({
      courseId: activity.courseId,
      date: day.date,
      position: index,
      type: activity.type,
      conceptId: activity.conceptId,
      modeId: activity.modeId,
      minutes: activity.minutes,
      reasons: activity.reasons,
    }))
  );
  const { data, error } = await client.rpc('save_study_plan', {
    p_plan: {
      horizonStart: result.horizonStart,
      horizonEnd: result.horizonEnd,
      timeZone,
      rulesVersion: result.rulesVersion,
      totalPlannedMinutes: result.totalPlannedMinutes,
      totalNeedMinutes: result.totalNeedMinutes,
      capacityMinutes: result.capacityMinutes,
      overCapacity: result.overCapacity,
      activities,
    },
  });
  if (error) throw error;
  return data as string;
}

/** The single active plan revision plus its activity rows, or null. */
export async function fetchActivePlan(
  client: SupabaseClient,
  userId: string
): Promise<StoredPlan | null> {
  const { data, error } = await client
    .from('study_plans')
    .select(
      'id, revision, horizon_start, horizon_end, time_zone, total_planned_minutes, ' +
        'total_need_minutes, capacity_minutes, over_capacity, created_at'
    )
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const plan = data as unknown as StoredPlanRow;
  const activityRes = await client
    .from('planned_activities')
    .select(
      'id, course_id, activity_date, position, activity_type, concept_id, mode_id, minutes, ' +
        'reasons, status, session_id, simulation_session_id'
    )
    .eq('plan_id', plan.id)
    .order('activity_date')
    .order('position');
  if (activityRes.error) throw activityRes.error;
  return { plan, activities: (activityRes.data ?? []) as unknown as StoredActivityRow[] };
}

export async function startPlannedActivity(
  client: SupabaseClient,
  activityId: string
): Promise<void> {
  const { error } = await client.rpc('start_planned_activity', { p_activity_id: activityId });
  if (error) throw error;
}

export async function skipPlannedActivity(
  client: SupabaseClient,
  activityId: string
): Promise<void> {
  const { error } = await client.rpc('skip_planned_activity', { p_activity_id: activityId });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Completion reconciliation (spec U/Z/AN)
// ---------------------------------------------------------------------------

interface CompletedSessionQueryRow {
  id: string;
  course_id: string;
  session_type: string;
  completed_at: string;
}

/**
 * Reconcile ACTUAL completed work against the stored plan: fetch completed
 * study + simulation sessions since the horizon start, run the pure matcher,
 * and bind each assignment through the idempotent RPC. Screen-opens never
 * count (spec U); a session satisfies at most one activity ever (spec AN).
 * Returns the number of activities newly marked completed.
 */
export async function reconcilePlanCompletion(
  client: SupabaseClient,
  stored: StoredPlan
): Promise<number> {
  const sinceIso = `${stored.plan.horizon_start}T00:00:00Z`;
  const [studyRes, simRes] = await Promise.all([
    client
      .from('study_sessions')
      .select('id, course_id, session_type, completed_at')
      .eq('status', 'completed')
      .gte('completed_at', sinceIso)
      .order('completed_at', { ascending: true })
      .limit(200),
    client
      .from('simulation_sessions')
      .select('id, course_id, completed_at')
      .eq('status', 'completed')
      .gte('completed_at', sinceIso)
      .order('completed_at', { ascending: true })
      .limit(50),
  ]);
  if (studyRes.error) throw studyRes.error;
  if (simRes.error) throw simRes.error;

  const simulationIds = new Set(
    ((simRes.data ?? []) as CompletedSessionQueryRow[]).map((row) => row.id)
  );
  const sessions: CompletedSessionLike[] = [
    ...((studyRes.data ?? []) as CompletedSessionQueryRow[]).map((row) => ({
      sessionId: row.id,
      courseId: row.course_id,
      sessionType: row.session_type,
      completedAt: row.completed_at,
    })),
    ...((simRes.data ?? []) as CompletedSessionQueryRow[]).map((row) => ({
      sessionId: row.id,
      courseId: row.course_id,
      sessionType: 'simulation',
      completedAt: row.completed_at,
    })),
  ];

  const boundSessionIds = new Set(
    stored.activities.flatMap((a) =>
      [a.session_id, a.simulation_session_id].filter((id): id is string => id !== null)
    )
  );
  const matchable: MatchableActivity[] = stored.activities.map((activity) => ({
    activityId: activity.id,
    courseId: activity.course_id,
    type: activity.activity_type,
    boundSessionId: activity.session_id ?? activity.simulation_session_id,
  }));
  const assignments = matchSessionsToActivities(
    matchable.filter(
      (a) =>
        a.boundSessionId === null &&
        ['planned', 'started'].includes(
          stored.activities.find((row) => row.id === a.activityId)?.status ?? ''
        )
    ),
    sessions.filter((s) => !boundSessionIds.has(s.sessionId))
  );

  let completed = 0;
  for (const assignment of assignments) {
    const isSimulation = simulationIds.has(assignment.sessionId);
    const { error } = await client.rpc('complete_planned_activity', {
      p_activity_id: assignment.activityId,
      p_session_id: isSimulation ? null : assignment.sessionId,
      p_simulation_session_id: isSimulation ? assignment.sessionId : null,
    });
    // A lost race (another device bound the session first) is fine: the RPC
    // is idempotent and the next reconcile pass converges (spec AN).
    if (!error) completed += 1;
  }
  return completed;
}
