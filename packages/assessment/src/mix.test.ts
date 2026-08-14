import { buildSessionQuestionOrder, pickGenerationConcepts } from './mix';

const question = (id: string, conceptId: string | null) => ({
  id,
  conceptId,
  questionType: 'single_best_answer',
  difficulty: 'moderate',
});

describe('generation concept selection (M7 spec Y/AA)', () => {
  it('takes the highest-emphasis concepts, bounded, with deterministic ties', () => {
    const concepts = [
      { key: 'b', emphasisScore: 5 },
      { key: 'a', emphasisScore: 5 },
      { key: 'c', emphasisScore: 9 },
      { key: 'd', emphasisScore: 1 },
    ];
    expect(pickGenerationConcepts(concepts, 3).map((concept) => concept.key)).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(pickGenerationConcepts(concepts, 0)).toEqual([]);
  });
});

describe('session question mixing (M7 spec V/Z — deterministic, never adaptive)', () => {
  const pool = [
    question('q1', 'k'),
    question('q2', 'k'),
    question('q3', 'k'),
    question('q4', 'dka'),
    question('q5', 'dka'),
    question('q6', 'hf'),
    question('q7', null),
  ];

  it('is deterministic for a given seed and differs across seeds', () => {
    const a = buildSessionQuestionOrder(pool, 5, 'session-1');
    const b = buildSessionQuestionOrder(pool, 5, 'session-1');
    const c = buildSessionQuestionOrder(pool, 5, 'session-2');
    expect(a.map((item) => item.id)).toEqual(b.map((item) => item.id));
    expect(a.map((item) => item.id)).not.toEqual(c.map((item) => item.id));
  });

  it('spreads selections across concepts before repeating one (spec Z)', () => {
    const picked = buildSessionQuestionOrder(pool, 4, 'seed');
    const concepts = new Set(picked.map((item) => item.conceptId));
    expect(concepts.size).toBe(4); // one from each bucket before any repeats
  });

  it('never repeats a question and caps at the pool size', () => {
    const picked = buildSessionQuestionOrder(pool, 50, 'seed');
    expect(picked).toHaveLength(pool.length);
    expect(new Set(picked.map((item) => item.id)).size).toBe(pool.length);
    expect(buildSessionQuestionOrder(pool, 0, 'seed')).toEqual([]);
    expect(buildSessionQuestionOrder([], 5, 'seed')).toEqual([]);
  });
});
