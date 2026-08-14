import { computeMedicationAnalytics, computeModeAnalytics, MODE_IDS } from './modes';
import { attempt, concept, resetFixtureIds, session } from './fixtures';

beforeEach(resetFixtureIds);

describe('mode analytics (spec W)', () => {
  it('lists all five modes and groups by stored session_type', () => {
    const sessions = [
      session({ sessionType: 'who_first', status: 'completed' }),
      session({ sessionType: 'who_first', status: 'abandoned' }),
      session({ sessionType: 'practice' }), // not a mode — ignored
    ];
    const attempts = Array.from({ length: 6 }, (_, i) =>
      attempt({ sessionType: 'who_first', isCorrect: i < 4 })
    );
    const rows = computeModeAnalytics(attempts, sessions);
    expect(rows.map((r) => r.modeId)).toEqual([...MODE_IDS]);
    const whoFirst = rows.find((r) => r.modeId === 'who_first')!;
    expect(whoFirst.sessionsStarted).toBe(2);
    expect(whoFirst.sessionsCompleted).toBe(1);
    expect(whoFirst.attempts).toBe(6);
    expect(whoFirst.accuracy).toEqual({ correct: 4, total: 6, accuracy: 4 / 6 });
  });

  it('hides accuracy below the mode evidence gate (spec AJ)', () => {
    const attempts = [attempt({ sessionType: 'boss_battle', isCorrect: true })];
    const rows = computeModeAnalytics(attempts, []);
    const boss = rows.find((r) => r.modeId === 'boss_battle')!;
    expect(boss.attempts).toBe(1);
    expect(boss.accuracy).toBeNull();
  });
});

describe('medication analytics (spec X)', () => {
  it('filters by medication concept type or numeric_calculation questions', () => {
    const concepts = [
      concept({ conceptId: 'med-1', conceptType: 'medication' }),
      concept({ conceptId: 'c-1', conceptType: 'condition' }),
    ];
    const attempts = [
      attempt({ conceptId: 'med-1', isCorrect: true }),
      attempt({ conceptId: 'med-1', isCorrect: true }),
      attempt({ conceptId: 'c-1', questionType: 'numeric_calculation', isCorrect: false }),
      attempt({ conceptId: 'c-1', isCorrect: false }), // excluded
      attempt({ conceptId: null, questionType: 'numeric_calculation', isCorrect: true }),
      attempt({ conceptId: 'med-1', isCorrect: false }),
    ];
    const result = computeMedicationAnalytics(attempts, concepts);
    expect(result.attempts).toBe(5);
    expect(result.accuracy).toEqual({ correct: 3, total: 5, accuracy: 3 / 5 });
  });

  it('reports counts without accuracy below the gate (spec X/AJ)', () => {
    const concepts = [concept({ conceptId: 'med-1', conceptType: 'medication' })];
    const result = computeMedicationAnalytics(
      [attempt({ conceptId: 'med-1', isCorrect: true })],
      concepts
    );
    expect(result.attempts).toBe(1);
    expect(result.accuracy).toBeNull();
  });
});
