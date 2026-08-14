import { masteryBand, masteryState } from './states';
import { initialAggregate, type MasteryAggregate } from './update';

const NOW = new Date('2026-08-13T12:00:00.000Z');

function assessed(overrides: Partial<MasteryAggregate> = {}): MasteryAggregate {
  return {
    ...initialAggregate(),
    attemptsCount: 3,
    correctCount: 2,
    mastery: 0.5,
    lastAttemptAt: '2026-08-12T12:00:00.000Z',
    nextReviewAt: '2026-08-15T12:00:00.000Z',
    ...overrides,
  };
}

describe('masteryBand (spec B/Q thresholds)', () => {
  it('maps the centralized thresholds', () => {
    expect(masteryBand(0)).toBe('needs_review');
    expect(masteryBand(0.39)).toBe('needs_review');
    expect(masteryBand(0.4)).toBe('developing');
    expect(masteryBand(0.74)).toBe('developing');
    expect(masteryBand(0.75)).toBe('strong');
    expect(masteryBand(1)).toBe('strong');
  });
});

describe('masteryState (spec C/J/Q)', () => {
  it('no evidence is unassessed, never needs_review (spec C)', () => {
    expect(masteryState(null, NOW)).toBe('unassessed');
    expect(masteryState(initialAggregate(), NOW)).toBe('unassessed');
  });

  it('assessed states follow the band while the review window is open', () => {
    expect(masteryState(assessed({ mastery: 0.2 }), NOW)).toBe('needs_review');
    expect(masteryState(assessed({ mastery: 0.5 }), NOW)).toBe('developing');
    expect(masteryState(assessed({ mastery: 0.9 }), NOW)).toBe('strong');
  });

  it('overlays due_for_review once the window passes, without erasing evidence (spec J)', () => {
    const overdue = assessed({ mastery: 0.9, nextReviewAt: '2026-08-13T11:00:00.000Z' });
    expect(masteryState(overdue, NOW)).toBe('due_for_review');
    expect(masteryBand(overdue.mastery)).toBe('strong'); // evidence intact
  });

  it('flips exactly at the due instant', () => {
    const dueNow = assessed({ nextReviewAt: NOW.toISOString() });
    expect(masteryState(dueNow, NOW)).toBe('due_for_review');
    const dueLater = assessed({ nextReviewAt: '2026-08-13T12:00:00.001Z' });
    expect(masteryState(dueLater, NOW)).toBe('developing');
  });
});
