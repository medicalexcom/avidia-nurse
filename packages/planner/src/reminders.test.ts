/**
 * Reminder-instruction tests — M13 (spec AA/AD/AE/AF/AJ/AY).
 */

import {
  availability,
  course,
  exam,
  input,
  prefs,
  resetFixtureIds,
  weakConcepts,
  FIXED_NOW,
  TZ,
} from './fixtures';
import { createStudyPlan } from './generate';
import { buildReminderInstructions, effectiveReminderHour, isQuietHour } from './reminders';

beforeEach(() => resetFixtureIds());

function planWithWork() {
  return createStudyPlan(
    input({
      courses: [course({ courseId: 'c1', ...weakConcepts(4) })],
      availability: availability(30),
    })
  );
}

describe('quiet hours (spec AD)', () => {
  it('detects hours inside a same-day window', () => {
    expect(isQuietHour(23, 22, 7)).toBe(true);
    expect(isQuietHour(3, 22, 7)).toBe(true);
    expect(isQuietHour(8, 22, 7)).toBe(false);
    expect(isQuietHour(12, 9, 17)).toBe(true);
    expect(isQuietHour(18, 9, 17)).toBe(false);
    expect(isQuietHour(5, 6, 6)).toBe(false); // zero-length window
  });

  it('slides a quiet-hours reminder to the window end', () => {
    expect(effectiveReminderHour(prefs({ reminderHour: 23 }))).toBe(7);
    expect(effectiveReminderHour(prefs({ reminderHour: 18 }))).toBe(18);
  });

  it('never emits a routine reminder inside quiet hours', () => {
    const out = buildReminderInstructions({
      prefs: prefs({ reminderHour: 23, quietStartHour: 22, quietEndHour: 7 }),
      plan: planWithWork(),
      exams: [exam('c1', 3, { examId: 'e1', title: 'Adult Health Exam' })],
      timeZone: TZ,
      now: FIXED_NOW,
    });
    expect(out.length).toBeGreaterThan(0);
    for (const instruction of out) {
      const hour = Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: TZ,
          hour: 'numeric',
          hour12: false,
        }).format(new Date(instruction.fireAt))
      );
      expect(isQuietHour(hour % 24, 22, 7)).toBe(false);
    }
  });
});

describe('study-plan reminders (spec AA)', () => {
  it('emits at most one study reminder per day, only for days with work', () => {
    const out = buildReminderInstructions({
      prefs: prefs({ examReminders: false }),
      plan: planWithWork(),
      exams: [],
      timeZone: TZ,
      now: FIXED_NOW,
    });
    const ids = out.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('plan:'))).toBe(true);
    // Today's 18:00 is still ahead of 11:00 local — included; max 7 days.
    expect(out.length).toBeLessThanOrEqual(7);
    expect(out[0]!.id).toBe('plan:2026-08-14');
  });

  it('respects fully disabled reminders (spec AC)', () => {
    const out = buildReminderInstructions({
      prefs: prefs({ studyReminders: false, reviewReminders: false, examReminders: false }),
      plan: planWithWork(),
      exams: [exam('c1', 3, { examId: 'e1' })],
      timeZone: TZ,
      now: FIXED_NOW,
    });
    expect(out).toEqual([]);
  });

  it('keeps notification content free of performance detail (spec AF)', () => {
    const out = buildReminderInstructions({
      prefs: prefs(),
      plan: planWithWork(),
      exams: [exam('c1', 3, { examId: 'e1', title: 'Adult Health Exam' })],
      timeZone: TZ,
      now: FIXED_NOW,
    });
    for (const instruction of out) {
      expect(instruction.body).not.toMatch(/fail|weak|wrong|mastery|misconception/i);
      expect(instruction.deepLink).toBe('/planner');
    }
  });

  it('skips reminder times already in the past', () => {
    const out = buildReminderInstructions({
      prefs: prefs({ reminderHour: 9, examReminders: false }), // 9:00 NY < 11:00 NY now
      plan: planWithWork(),
      exams: [],
      timeZone: TZ,
      now: FIXED_NOW,
    });
    expect(out.find((i) => i.id === 'plan:2026-08-14')).toBeUndefined();
    expect(out.find((i) => i.id === 'plan:2026-08-15')).toBeDefined();
  });
});

describe('exam reminders (spec AF/X)', () => {
  it('fires at 3 days and 1 day out with countdown-only copy', () => {
    const out = buildReminderInstructions({
      prefs: prefs({ studyReminders: false, reviewReminders: false }),
      plan: null,
      exams: [exam('c1', 5, { examId: 'e1', title: 'Pharmacology Exam' })],
      timeZone: TZ,
      now: FIXED_NOW,
    });
    expect(out.map((i) => i.id)).toEqual(['exam:e1:3', 'exam:e1:1']);
    expect(out[0]!.body).toBe('Pharmacology Exam in 3 days.');
    expect(out[1]!.body).toBe('Pharmacology Exam in 1 day.');
  });

  it('ignores past exams and already-passed lead days', () => {
    const out = buildReminderInstructions({
      prefs: prefs({ studyReminders: false, reviewReminders: false }),
      plan: null,
      exams: [
        exam('c1', -2, { examId: 'past' }),
        exam('c1', 2, { examId: 'soon', title: 'Patho Exam' }), // 3-day lead already gone
      ],
      timeZone: TZ,
      now: FIXED_NOW,
    });
    expect(out.map((i) => i.id)).toEqual(['exam:soon:1']);
  });
});

describe('timezone and DST (spec AJ)', () => {
  it('anchors fire times to the student timezone', () => {
    const out = buildReminderInstructions({
      prefs: prefs({ examReminders: false, reminderHour: 18 }),
      plan: planWithWork(),
      exams: [],
      timeZone: TZ,
      now: FIXED_NOW,
    });
    // 18:00 in America/New_York (EDT, UTC-4) is 22:00 UTC.
    expect(out[0]!.fireAt).toBe('2026-08-14T22:00:00.000Z');
  });

  it('keeps the local hour stable across the fall-back DST transition', () => {
    // US DST ends 2026-11-01 in America/New_York.
    resetFixtureIds();
    const nowNearDst = new Date('2026-10-30T15:00:00Z');
    const plan = createStudyPlan(
      input({
        courses: [course({ courseId: 'c1', ...weakConcepts(6) })],
        availability: availability(30),
        now: nowNearDst,
      })
    );
    const out = buildReminderInstructions({
      prefs: prefs({ examReminders: false, reminderHour: 18 }),
      plan,
      exams: [],
      timeZone: TZ,
      now: nowNearDst,
    });
    const before = out.find((i) => i.id === 'plan:2026-10-31');
    const after = out.find((i) => i.id === 'plan:2026-11-02');
    expect(before?.fireAt).toBe('2026-10-31T22:00:00.000Z'); // EDT: 18:00 = 22:00Z
    expect(after?.fireAt).toBe('2026-11-02T23:00:00.000Z'); // EST: 18:00 = 23:00Z
  });
});
