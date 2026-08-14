import type { ConceptType } from '@avidia/domain';

import {
  BOSS_ROUNDS,
  MODES,
  MODE_IDS,
  eligibleQuestions,
  getMode,
  isModeId,
  modeAvailability,
  segmentLabelAt,
  type ModeQuestion,
} from './registry';

const question = (overrides: Partial<ModeQuestion> & { id: string }): ModeQuestion => ({
  conceptId: null,
  questionType: 'single_best_answer',
  difficulty: 'moderate',
  cognitiveLevel: 'recall',
  priorityFrameworks: [],
  ...overrides,
});

const conceptTypes = (entries: [string, ConceptType][]) => new Map<string, ConceptType>(entries);

describe('mode registry', () => {
  it('exposes exactly the five blueprint modes', () => {
    expect(MODES.map((mode) => mode.id)).toEqual([...MODE_IDS]);
    expect(isModeId('boss_battle')).toBe(true);
    expect(isModeId('adaptive')).toBe(false);
    expect(isModeId(null)).toBe(false);
  });

  it('rapid_response keeps easy/moderate recall and understanding only', () => {
    const mode = getMode('rapid_response');
    const pool = [
      question({ id: 'a', cognitiveLevel: 'recall', difficulty: 'easy' }),
      question({ id: 'b', cognitiveLevel: 'understanding', difficulty: 'moderate' }),
      question({ id: 'c', cognitiveLevel: 'recall', difficulty: 'hard' }),
      question({ id: 'd', cognitiveLevel: 'application' }),
      question({ id: 'e', cognitiveLevel: 'prioritization' }),
    ];
    expect(eligibleQuestions(mode, pool, conceptTypes([])).map((q) => q.id)).toEqual(['a', 'b']);
  });

  it('find_the_danger requires danger concepts or the safety framework', () => {
    const mode = getMode('find_the_danger');
    const pool = [
      question({ id: 'a', conceptId: 'c-safety' }),
      question({ id: 'b', conceptId: 'c-sign', questionType: 'multiple_response' }),
      question({ id: 'c', conceptId: 'c-med' }),
      question({ id: 'd', priorityFrameworks: ['safety'] }),
      question({ id: 'e', conceptId: 'c-safety', questionType: 'numeric_calculation' }),
      question({ id: 'f' }),
    ];
    const types = conceptTypes([
      ['c-safety', 'safety'],
      ['c-sign', 'sign_symptom'],
      ['c-med', 'medication'],
    ]);
    expect(eligibleQuestions(mode, pool, types).map((q) => q.id)).toEqual(['a', 'b', 'd']);
  });

  it('who_first requires prioritization level or a priority framework', () => {
    const mode = getMode('who_first');
    const pool = [
      question({ id: 'a', cognitiveLevel: 'prioritization' }),
      question({ id: 'b', priorityFrameworks: ['abc'] }),
      question({ id: 'c', cognitiveLevel: 'analysis' }),
    ];
    expect(eligibleQuestions(mode, pool, conceptTypes([])).map((q) => q.id)).toEqual(['a', 'b']);
  });

  it('medication_lab takes medication/calculation concepts and numeric calculations', () => {
    const mode = getMode('medication_lab');
    const pool = [
      question({ id: 'a', conceptId: 'c-med' }),
      question({ id: 'b', questionType: 'numeric_calculation' }),
      question({ id: 'c', conceptId: 'c-calc' }),
      question({ id: 'd', conceptId: 'c-safety' }),
    ];
    const types = conceptTypes([
      ['c-med', 'medication'],
      ['c-calc', 'calculation'],
      ['c-safety', 'safety'],
    ]);
    expect(eligibleQuestions(mode, pool, types).map((q) => q.id)).toEqual(['a', 'b', 'c']);
  });

  it('modeAvailability applies each mode minimum and reports counts', () => {
    const pool = [
      question({ id: 'a', cognitiveLevel: 'recall', difficulty: 'easy' }),
      question({ id: 'b', cognitiveLevel: 'understanding' }),
      question({ id: 'c', cognitiveLevel: 'recall' }),
      question({ id: 'd', cognitiveLevel: 'recall' }),
      question({ id: 'e', cognitiveLevel: 'prioritization' }),
    ];
    const availability = modeAvailability(pool, conceptTypes([]));
    const byId = new Map(availability.map((entry) => [entry.mode.id, entry]));
    expect(byId.get('rapid_response')).toMatchObject({ availableCount: 4, eligible: true });
    expect(byId.get('who_first')).toMatchObject({ availableCount: 1, eligible: false });
    expect(byId.get('medication_lab')).toMatchObject({ availableCount: 0, eligible: false });
    // Boss Battle sees the whole bank but needs 8.
    expect(byId.get('boss_battle')).toMatchObject({ availableCount: 5, eligible: false });
  });

  it('every mode has a locked message for its empty state', () => {
    for (const mode of MODES) {
      expect(mode.lockedMessage.length).toBeGreaterThan(10);
    }
  });

  it('mode ordering is deterministic for the same seed and differs across seeds', () => {
    const mode = getMode('rapid_response');
    const pool = Array.from({ length: 12 }, (_, index) =>
      question({ id: `q${index}`, cognitiveLevel: 'recall', difficulty: 'easy' })
    );
    const first = mode.buildOrder(pool, 8, 'session-1');
    const again = mode.buildOrder(pool, 8, 'session-1');
    const other = mode.buildOrder(pool, 8, 'session-2');
    expect(again.questionIds).toEqual(first.questionIds);
    expect(first.questionIds).toHaveLength(8);
    expect(new Set(first.questionIds).size).toBe(8);
    expect(other.questionIds).not.toEqual(first.questionIds);
    expect(first.segments).toEqual([]);
  });

  it('boss battle orders rounds Foundation → Application → Prioritization → Integrated', () => {
    const pool = [
      ...Array.from({ length: 6 }, (_, i) => question({ id: `r${i}`, cognitiveLevel: 'recall' })),
      ...Array.from({ length: 4 }, (_, i) =>
        question({ id: `a${i}`, cognitiveLevel: 'application' })
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        question({ id: `p${i}`, cognitiveLevel: 'prioritization' })
      ),
    ];
    const plan = getMode('boss_battle').buildOrder(pool, 12, 'boss-seed');
    expect(plan.questionIds).toHaveLength(12);
    expect(new Set(plan.questionIds).size).toBe(12);
    expect(plan.segments.map((segment) => segment.label)).toEqual([
      'Foundation',
      'Application',
      'Prioritization',
      'Integrated',
    ]);
    // Segments partition the plan, and each labeled round only contains
    // questions of its cognitive tier.
    expect(plan.segments.reduce((sum, segment) => sum + segment.count, 0)).toBe(12);
    let offset = 0;
    for (const [index, round] of BOSS_ROUNDS.entries()) {
      const segment = plan.segments[index]!;
      const ids = plan.questionIds.slice(offset, offset + segment.count);
      const levelById = new Map(pool.map((q) => [q.id, q.cognitiveLevel]));
      for (const id of ids) {
        expect(round.levels).toContain(levelById.get(id));
      }
      offset += segment.count;
    }
    // Deterministic.
    expect(getMode('boss_battle').buildOrder(pool, 12, 'boss-seed').questionIds).toEqual(
      plan.questionIds
    );
  });

  it('boss battle skips rounds the bank cannot fill instead of inventing content', () => {
    const pool = Array.from({ length: 9 }, (_, i) =>
      question({ id: `r${i}`, cognitiveLevel: 'recall' })
    );
    const plan = getMode('boss_battle').buildOrder(pool, 8, 'seed');
    expect(plan.segments.map((segment) => segment.label)).toEqual(['Foundation', 'Integrated']);
    expect(plan.questionIds.length).toBeLessThanOrEqual(8);
  });

  it('segmentLabelAt maps positions to their round', () => {
    const plan = {
      questionIds: ['a', 'b', 'c'],
      segments: [
        { label: 'Foundation', count: 2 },
        { label: 'Integrated', count: 1 },
      ],
    };
    expect(segmentLabelAt(plan, 0)).toBe('Foundation');
    expect(segmentLabelAt(plan, 1)).toBe('Foundation');
    expect(segmentLabelAt(plan, 2)).toBe('Integrated');
    expect(segmentLabelAt({ questionIds: ['a'], segments: [] }, 0)).toBeNull();
  });

  it('mode copy never shames speed or punishes the student', () => {
    for (const mode of MODES) {
      const copy = `${mode.tagline} ${mode.lockedMessage}`.toLowerCase();
      for (const banned of ['fail', 'wrong', 'bad', 'hurry', 'faster', 'lose your']) {
        expect(copy).not.toContain(banned);
      }
    }
  });
});
