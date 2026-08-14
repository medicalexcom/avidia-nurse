import { computeSimulationAnalytics } from './simulationAnalytics';
import { computeClinicalJudgment } from './clinicalJudgment';
import { attempt, daysAgo, resetFixtureIds, simulation } from './fixtures';

beforeEach(resetFixtureIds);

describe('simulation analytics (spec Z/AA)', () => {
  it('aggregates outcomes, criticals, and unsafe actions honestly', () => {
    const result = computeSimulationAnalytics([
      simulation({ outcomeKind: 'stabilized', criticalMissedCount: 0, unsafeActionCount: 0 }),
      simulation({ outcomeKind: 'deteriorated', criticalMissedCount: 2, unsafeActionCount: 1 }),
    ]);
    expect(result.completedCount).toBe(2);
    expect(result.outcomes.stabilized).toBe(1);
    expect(result.outcomes.deteriorated).toBe(1);
    expect(result.totalCriticalMissed).toBe(2);
    expect(result.totalUnsafeActions).toBe(1);
  });

  it('gates trend language until enough completed sessions (spec AA)', () => {
    const two = computeSimulationAnalytics([
      simulation({ completedAt: daysAgo(5), earned: 4, possible: 16 }),
      simulation({ completedAt: daysAgo(1), earned: 14, possible: 16 }),
    ]);
    expect(two.scoreTrend).toBe('insufficient');

    const four = computeSimulationAnalytics([
      simulation({ completedAt: daysAgo(8), earned: 4, possible: 16 }),
      simulation({ completedAt: daysAgo(6), earned: 5, possible: 16 }),
      simulation({ completedAt: daysAgo(3), earned: 12, possible: 16 }),
      simulation({ completedAt: daysAgo(1), earned: 14, possible: 16 }),
    ]);
    expect(four.scoreTrend).toBe('improving');
  });

  it('finds the weakest dimension only with sufficient evidence (student D)', () => {
    const sims = [0, 1, 2].map((i) =>
      simulation({
        completedAt: daysAgo(6 - i * 2),
        dimensions: [
          { dimension: 'recognize_cues', label: 'Recognize cues', earned: 4, possible: 4 },
          { dimension: 'evaluate_outcomes', label: 'Evaluate outcomes', earned: 0, possible: 4 },
        ],
      })
    );
    const result = computeSimulationAnalytics(sims);
    expect(result.weakestDimension?.dimension).toBe('evaluate_outcomes');
    expect(result.weakestDimension?.share).toBe(0);
    const cues = result.dimensions.find((d) => d.dimension === 'recognize_cues')!;
    expect(cues.share).toBe(1);
  });

  it('hides dimension shares below the evidence gate', () => {
    const result = computeSimulationAnalytics([
      simulation({
        dimensions: [{ dimension: 'take_action', label: 'Take action', earned: 1, possible: 2 }],
      }),
    ]);
    expect(result.dimensions[0]!.share).toBeNull();
    expect(result.weakestDimension).toBeNull();
  });

  it('is deterministic regardless of input order', () => {
    const a = simulation({ sessionId: 'sim-a', completedAt: daysAgo(3) });
    const b = simulation({ sessionId: 'sim-b', completedAt: daysAgo(1) });
    expect(computeSimulationAnalytics([a, b])).toEqual(computeSimulationAnalytics([b, a]));
  });
});

describe('clinical judgment (spec Y)', () => {
  it('keeps question and simulation evidence side by side, never merged', () => {
    const attempts = Array.from({ length: 6 }, (_, i) =>
      attempt({ cognitiveLevel: 'prioritization', isCorrect: i < 2 })
    );
    const result = computeClinicalJudgment(attempts, [simulation()]);
    expect(result.prioritizationQuestions.accuracy).toEqual({
      correct: 2,
      total: 6,
      accuracy: 2 / 6,
    });
    expect(result.analysisQuestions.accuracy).toBeNull(); // no analysis attempts
    expect(result.completedSimulations).toBe(1);
    // No combined/blended score field exists.
    expect(Object.keys(result)).toEqual([
      'analysisQuestions',
      'prioritizationQuestions',
      'simulationDimensions',
      'completedSimulations',
    ]);
  });
});
