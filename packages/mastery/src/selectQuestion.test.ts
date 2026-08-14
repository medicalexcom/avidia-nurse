import { buildAdaptiveQuestionOrder, type SelectableQuestion } from './selectQuestion';
import type { StudyRecommendation } from './recommend';

function rec(conceptId: string, priority: number): StudyRecommendation {
  return {
    conceptId,
    priority,
    factors: {
      examRelevance: 1,
      weakness: 1,
      forgettingRisk: 1,
      emphasisFactor: 1,
      misconceptionMultiplier: 1,
      transferNeed: 1,
    },
    masteryState: 'needs_review',
    reasonCodes: ['low_mastery'],
    recommendedQuestionCharacteristics: {
      difficulties: ['easy', 'moderate'],
      cognitiveLevels: ['recall', 'understanding', 'application'],
    },
    nextReviewAt: null,
    urgentExamId: null,
  };
}

function q(
  questionId: string,
  conceptId: string | null,
  overrides: Partial<SelectableQuestion> = {}
): SelectableQuestion {
  return {
    questionId,
    conceptId,
    difficulty: 'moderate',
    cognitiveLevel: 'application',
    seen: false,
    ...overrides,
  };
}

const RANKED = [rec('c1', 3), rec('c2', 2), rec('c3', 1)];

function bank(perConcept: number): SelectableQuestion[] {
  const out: SelectableQuestion[] = [];
  for (const c of ['c1', 'c2', 'c3']) {
    for (let i = 0; i < perConcept; i++) out.push(q(`${c}-q${i}`, c));
  }
  return out;
}

describe('buildAdaptiveQuestionOrder (spec U/V/W/AB)', () => {
  it('is deterministic for the same seed and differs across seeds', () => {
    const input = { questions: bank(5), ranked: RANKED, sessionSize: 10, seed: 'session-1' };
    expect(buildAdaptiveQuestionOrder(input)).toEqual(buildAdaptiveQuestionOrder(input));
    const other = buildAdaptiveQuestionOrder({ ...input, seed: 'session-2' });
    expect(other).not.toEqual(buildAdaptiveQuestionOrder(input));
  });

  it('never emits duplicates and respects the session size', () => {
    const order = buildAdaptiveQuestionOrder({
      questions: bank(5),
      ranked: RANKED,
      sessionSize: 10,
      seed: 's',
    });
    expect(order).toHaveLength(10);
    expect(new Set(order).size).toBe(10);
  });

  it('caps consecutive same-concept questions (spec W)', () => {
    const order = buildAdaptiveQuestionOrder({
      questions: bank(6),
      ranked: RANKED,
      sessionSize: 12,
      seed: 's',
    });
    let run = 1;
    for (let i = 1; i < order.length; i++) {
      const prev = order[i - 1]!.split('-')[0];
      const cur = order[i]!.split('-')[0];
      run = cur === prev ? run + 1 : 1;
      expect(run).toBeLessThanOrEqual(2);
    }
  });

  it('caps any concept share of the session when others have supply (spec W)', () => {
    const order = buildAdaptiveQuestionOrder({
      questions: bank(10),
      ranked: RANKED,
      sessionSize: 10,
      seed: 's',
    });
    const counts = new Map<string, number>();
    for (const id of order) {
      const c = id.split('-')[0]!;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    for (const count of counts.values()) expect(count).toBeLessThanOrEqual(5);
  });

  it('fills the session from one concept when nothing else exists (spec AN fallback)', () => {
    const only = Array.from({ length: 5 }, (_, i) => q(`c1-q${i}`, 'c1'));
    const order = buildAdaptiveQuestionOrder({
      questions: only,
      ranked: [rec('c1', 1)],
      sessionSize: 5,
      seed: 's',
    });
    expect(order).toHaveLength(5);
  });

  it('prefers unseen questions before repeats (spec U)', () => {
    const questions = [
      q('c1-old0', 'c1', { seen: true }),
      q('c1-old1', 'c1', { seen: true }),
      q('c1-new0', 'c1'),
      q('c1-new1', 'c1'),
    ];
    const order = buildAdaptiveQuestionOrder({
      questions,
      ranked: [rec('c1', 1)],
      sessionSize: 2,
      seed: 's',
    });
    expect(order.every((id) => id.startsWith('c1-new'))).toBe(true);
  });

  it('prefers mastery-appropriate characteristics within a concept (spec U)', () => {
    const questions = [
      q('c1-hard', 'c1', { difficulty: 'hard', cognitiveLevel: 'prioritization' }),
      q('c1-easy', 'c1', { difficulty: 'easy', cognitiveLevel: 'recall' }),
    ];
    const order = buildAdaptiveQuestionOrder({
      questions,
      ranked: [rec('c1', 1)], // targets easy/moderate + recall..application
      sessionSize: 1,
      seed: 's',
    });
    expect(order).toEqual(['c1-easy']);
  });

  it('returns fewer than requested when the bank is smaller — never invents (spec Y)', () => {
    const order = buildAdaptiveQuestionOrder({
      questions: bank(1),
      ranked: RANKED,
      sessionSize: 20,
      seed: 's',
    });
    expect(order).toHaveLength(3);
  });

  it('includes concept-less questions as a trailing pool', () => {
    const questions = [q('c1-q0', 'c1'), q('orphan-q0', null)];
    const order = buildAdaptiveQuestionOrder({
      questions,
      ranked: [rec('c1', 1)],
      sessionSize: 2,
      seed: 's',
    });
    expect(order).toContain('orphan-q0');
  });

  it('handles empty inputs safely', () => {
    expect(
      buildAdaptiveQuestionOrder({ questions: [], ranked: RANKED, sessionSize: 5, seed: 's' })
    ).toEqual([]);
    expect(
      buildAdaptiveQuestionOrder({ questions: bank(2), ranked: [], sessionSize: 0, seed: 's' })
    ).toEqual([]);
  });
});
