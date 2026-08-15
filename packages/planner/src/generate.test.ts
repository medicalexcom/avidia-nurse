/**
 * Golden planner scenarios — M13 (spec AX cases A-H) plus allocator units.
 */

import {
  availability,
  course,
  exam,
  input,
  resetFixtureIds,
  weakConcepts,
  FIXED_NOW,
  TZ,
} from './fixtures';
import { createStudyPlan, getTodayPlan, getUpcomingPlan, splitBudget } from './generate';
import { uniformWeek } from './availability';

beforeEach(() => resetFixtureIds());

describe('splitBudget', () => {
  it('splits exactly and deterministically by largest remainder', () => {
    expect(splitBudget(45, [1, 1, 1])).toEqual([15, 15, 15]);
    expect(splitBudget(46, [1, 1, 1])).toEqual([16, 15, 15]);
    expect(splitBudget(30, [3, 1])).toEqual([23, 7]);
    expect(splitBudget(0, [1, 2])).toEqual([0, 0]);
    expect(splitBudget(30, [0, 0])).toEqual([0, 0]);
  });
});

describe('case A — exam in 7 days, 45 min/day, several weak concepts', () => {
  const examA = exam('c1', 7, { examId: 'exam-a', title: 'Adult Health Exam' });
  const { recommendations, conceptNames } = weakConcepts(5, { examId: 'exam-a' });
  const plan = createStudyPlan(
    input({
      courses: [course({ courseId: 'c1', recommendations, conceptNames, exams: [examA] })],
      availability: availability(45),
    })
  );

  it('distributes work across the days before the exam', () => {
    const daysWithWork = plan.days.slice(0, 7).filter((d) => d.plannedMinutes > 0);
    expect(daysWithWork.length).toBeGreaterThanOrEqual(2);
  });

  it('never overfills a day (spec P)', () => {
    for (const day of plan.days) {
      expect(day.plannedMinutes).toBeLessThanOrEqual(day.availableMinutes);
    }
  });

  it('explains items with exam and mastery reasons (spec O)', () => {
    const today = getTodayPlan(plan)!;
    const first = today.activities[0]!;
    const codes = first.reasons.map((r) => r.code);
    expect(codes).toContain('exam_soon');
    expect(codes).toContain('low_mastery');
    expect(first.reasons.find((r) => r.code === 'exam_soon')?.daysUntilExam).toBe(7);
  });

  it('does not repeat the same concept twice in one day (spec J)', () => {
    for (const day of plan.days) {
      const ids = day.activities.map((a) => a.conceptId).filter((id) => id !== null);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('is deterministic', () => {
    resetFixtureIds();
    const { recommendations: r2, conceptNames: n2 } = weakConcepts(5, { examId: 'exam-a' });
    const again = createStudyPlan(
      input({
        courses: [
          course({
            courseId: 'c1',
            recommendations: r2,
            conceptNames: n2,
            exams: [exam('c1', 7, { examId: 'exam-a', title: 'Adult Health Exam' })],
          }),
        ],
        availability: availability(45),
      })
    );
    expect(again).toEqual(plan);
  });
});

describe('case B — exam tomorrow, 30 minutes, multiple unmet priorities', () => {
  const { recommendations, conceptNames } = weakConcepts(8, { examId: 'exam-b' });
  const plan = createStudyPlan(
    input({
      courses: [
        course({
          courseId: 'c1',
          recommendations,
          conceptNames,
          dueReviewConceptIds: ['weak-7', 'weak-8'],
          exams: [exam('c1', 1, { examId: 'exam-b' })],
        }),
      ],
      availability: availability(30),
    })
  );

  it('triages the highest-value material into today without overload', () => {
    const today = getTodayPlan(plan)!;
    expect(today.plannedMinutes).toBeLessThanOrEqual(30);
    expect(today.activities.length).toBeGreaterThan(0);
    // Top-priority concepts (M8 order) come first.
    expect(today.activities[0]!.conceptId).toBe('weak-1');
  });

  it('reports the capacity constraint honestly (spec P)', () => {
    // Need: 6×15 priorities + review block(s) > the 30 minutes before the exam.
    expect(plan.totalNeedMinutes).toBeGreaterThan(plan.capacityMinutes);
    expect(plan.overCapacity).toBe(true);
  });
});

describe('case C — two exams in 3 and 6 days', () => {
  const { recommendations: recA, conceptNames: namesA } = weakConcepts(4, { examId: 'exam-near' });
  const plan = createStudyPlan(
    input({
      courses: [
        course({
          courseId: 'course-a',
          courseTitle: 'Adult Health',
          recommendations: recA,
          conceptNames: namesA,
          exams: [exam('course-a', 3, { examId: 'exam-near', title: 'Adult Health Exam' })],
        }),
        course({
          courseId: 'course-b',
          courseTitle: 'Pharmacology',
          recommendations: weakConcepts(4, { examId: 'exam-far' }).recommendations,
          conceptNames: weakConcepts(4, { examId: 'exam-far' }).conceptNames,
          unassessedConceptIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'],
          exams: [exam('course-b', 6, { examId: 'exam-far', title: 'Pharmacology Exam' })],
        }),
      ],
      availability: availability(60),
    })
  );

  it('distributes time across BOTH courses (spec F — no winner-takes-all)', () => {
    const firstThreeDays = plan.days.slice(0, 3);
    const courses = new Set(firstThreeDays.flatMap((d) => d.activities.map((a) => a.courseId)));
    expect(courses.has('course-a')).toBe(true);
    expect(courses.has('course-b')).toBe(true);
  });

  it('schedules coverage diagnostics for the unassessed course (spec I)', () => {
    const all = plan.days.flatMap((d) => d.activities);
    const coverage = all.filter(
      (a) => a.courseId === 'course-b' && a.reasons.some((r) => r.code === 'coverage_gap')
    );
    expect(coverage.length).toBeGreaterThan(0);
  });

  it('marks exam days in the week view (spec W/X)', () => {
    expect(plan.days[3]!.examIds).toContain('exam-near');
    expect(plan.days[6]!.examIds).toContain('exam-far');
  });
});

describe('case D — strong mastery but overdue reviews', () => {
  const plan = createStudyPlan(
    input({
      courses: [
        course({
          courseId: 'c1',
          recommendations: [],
          dueReviewConceptIds: ['r1', 'r2', 'r3', 'r4'],
        }),
      ],
      availability: availability(30),
    })
  );

  it('reserves review time (spec H)', () => {
    const today = getTodayPlan(plan)!;
    expect(today.activities.some((a) => a.type === 'due_review')).toBe(true);
  });
});

describe('case E — high accuracy but substantial unassessed exam scope', () => {
  const plan = createStudyPlan(
    input({
      courses: [
        course({
          courseId: 'c1',
          recommendations: [],
          unassessedConceptIds: Array.from({ length: 20 }, (_, i) => `u${i}`),
          assessedCoverage: 0.3,
          exams: [exam('c1', 5, { examId: 'exam-e' })],
        }),
      ],
      availability: availability(30),
    })
  );

  it('allocates diagnostic coverage blocks, not weakness drills (spec I)', () => {
    const all = plan.days.flatMap((d) => d.activities);
    const coverage = all.filter((a) => a.reasons.some((r) => r.code === 'coverage_gap'));
    expect(coverage.length).toBeGreaterThan(0);
    expect(coverage.every((a) => a.type === 'start_today')).toBe(true);
  });
});

describe('cases F/G — recalculation is regeneration', () => {
  it('replans remaining priorities after missed days without stacking (spec S)', () => {
    const examId = 'exam-f';
    const build = (daysToExam: number, weakCount: number) => {
      resetFixtureIds();
      const { recommendations, conceptNames } = weakConcepts(weakCount, { examId });
      return createStudyPlan(
        input({
          courses: [
            course({
              courseId: 'c1',
              recommendations,
              conceptNames,
              exams: [exam('c1', daysToExam, { examId })],
            }),
          ],
          availability: availability(30),
          now: new Date(FIXED_NOW.getTime() + (7 - daysToExam) * 86_400_000),
        })
      );
    };
    const original = build(7, 6);
    // Two missed days later: same unmet need, fewer days. The new plan
    // starts at the NEW today and still never overfills a day.
    const recalculated = build(5, 6);
    expect(recalculated.horizonStart).not.toBe(original.horizonStart);
    for (const day of recalculated.days) {
      expect(day.plannedMinutes).toBeLessThanOrEqual(day.availableMinutes);
    }
    expect(recalculated.days[0]!.activities[0]!.conceptId).toBe('weak-1');
  });

  it('drops satisfied work when mastery improved (spec T)', () => {
    const examId = 'exam-g';
    resetFixtureIds();
    const before = createStudyPlan(
      input({
        courses: [
          course({
            courseId: 'c1',
            ...weakConcepts(4, { examId }),
            exams: [exam('c1', 6, { examId })],
          }),
        ],
      })
    );
    resetFixtureIds();
    // Extra study fixed two concepts: M8 no longer recommends them.
    const after = createStudyPlan(
      input({
        courses: [
          course({
            courseId: 'c1',
            ...weakConcepts(2, { examId }),
            exams: [exam('c1', 6, { examId })],
          }),
        ],
      })
    );
    const conceptsBefore = new Set(
      before.days.flatMap((d) => d.activities.map((a) => a.conceptId)).filter(Boolean)
    );
    const conceptsAfter = new Set(
      after.days.flatMap((d) => d.activities.map((a) => a.conceptId)).filter(Boolean)
    );
    expect(conceptsBefore.has('weak-3')).toBe(true);
    expect(conceptsAfter.has('weak-3')).toBe(false);
    expect(after.totalNeedMinutes).toBeLessThan(before.totalNeedMinutes);
  });
});

describe('case H — no exam', () => {
  const plan = createStudyPlan(
    input({
      courses: [
        course({
          courseId: 'c1',
          recommendations: weakConcepts(2).recommendations,
          conceptNames: weakConcepts(2).conceptNames,
          dueReviewConceptIds: ['r1'],
        }),
      ],
      availability: availability(30),
    })
  );

  it('still produces a general review/mastery plan (spec AR)', () => {
    const today = getTodayPlan(plan)!;
    expect(today.plannedMinutes).toBeGreaterThan(0);
    expect(plan.overCapacity).toBe(false);
    // Reviews are reserved early in the plan (tier order puts today's
    // budget on the top priorities; the review block lands right after).
    const firstTwoDays = plan.days.slice(0, 2).flatMap((d) => d.activities);
    expect(firstTwoDays.some((a) => a.type === 'due_review')).toBe(true);
  });
});

describe('other engine behaviors', () => {
  it('zero availability yields empty days (spec AR: prompt for setup)', () => {
    const plan = createStudyPlan(
      input({
        courses: [course({ courseId: 'c1', ...weakConcepts(3) })],
        availability: { preset: 'custom', minutesByWeekday: uniformWeek(0) },
      })
    );
    expect(plan.totalPlannedMinutes).toBe(0);
  });

  it('schedules a simulation only on days with enough budget (spec L)', () => {
    const small = createStudyPlan(
      input({
        courses: [course({ courseId: 'c1', simulationAvailable: true })],
        availability: availability(15),
      })
    );
    expect(small.days.flatMap((d) => d.activities).some((a) => a.type === 'simulation')).toBe(
      false
    );

    const roomy = createStudyPlan(
      input({
        courses: [course({ courseId: 'c1', simulationAvailable: true })],
        availability: availability(45),
      })
    );
    const sims = roomy.days.flatMap((d) => d.activities).filter((a) => a.type === 'simulation');
    expect(sims.length).toBe(1);
    expect(sims[0]!.reasons.map((r) => r.code)).toContain('clinical_practice');
  });

  it('schedules a Priority Challenge for a higher-order gap (spec K)', () => {
    const plan = createStudyPlan(
      input({
        courses: [course({ courseId: 'c1', higherOrderGap: true })],
        availability: availability(30),
      })
    );
    const item = plan.days
      .flatMap((d) => d.activities)
      .find((a) => a.type === 'priority_challenge');
    expect(item).toBeDefined();
    expect(item!.modeId).toBe('who_first');
    expect(item!.reasons.map((r) => r.code)).toContain('higher_order_gap');
  });

  it('misconception slots lead the day but are capped (spec J/Q)', () => {
    const recs = [
      ...weakConcepts(3).recommendations.map((r, i) => ({
        ...r,
        conceptId: `mis-${i}`,
        factors: { ...r.factors, misconceptionMultiplier: 1.8 },
      })),
      ...weakConcepts(2).recommendations,
    ];
    const names = Object.fromEntries(recs.map((r) => [r.conceptId, r.conceptId]));
    const plan = createStudyPlan(
      input({
        courses: [course({ courseId: 'c1', recommendations: recs, conceptNames: names })],
        availability: availability(60),
      })
    );
    const today = getTodayPlan(plan)!;
    const misToday = today.activities.filter((a) =>
      a.reasons.some((r) => r.code === 'misconception_signal')
    );
    expect(misToday.length).toBe(2); // capped, not hammered all day
    expect(today.activities[0]!.reasons.map((r) => r.code)).toContain('misconception_signal');
  });

  it('getUpcomingPlan returns the week after today (spec W)', () => {
    const plan = createStudyPlan(input({ courses: [course({ courseId: 'c1' })] }));
    const upcoming = getUpcomingPlan(plan);
    expect(upcoming.length).toBe(6);
    expect(upcoming[0]!.date).toBe(plan.days[1]!.date);
  });

  it('uses the student timezone for plan days (spec AJ)', () => {
    // 2026-08-15 03:00 UTC is still 2026-08-14 in New York.
    const lateNight = new Date('2026-08-15T03:00:00Z');
    const plan = createStudyPlan(
      input({ courses: [course({ courseId: 'c1' })], now: lateNight, timeZone: TZ })
    );
    expect(plan.horizonStart).toBe('2026-08-14');
    const utcPlan = createStudyPlan(
      input({ courses: [course({ courseId: 'c1' })], now: lateNight, timeZone: 'UTC' })
    );
    expect(utcPlan.horizonStart).toBe('2026-08-15');
  });
});
