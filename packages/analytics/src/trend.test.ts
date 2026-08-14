import { classifyTrend } from './trend';
import { MIN_TREND_ATTEMPTS_PER_WINDOW, TREND_DELTA_THRESHOLD } from './thresholds';

const correct = { isCorrect: true };
const wrong = { isCorrect: false };

function outcomes(correctCount: number, total: number) {
  return Array.from({ length: total }, (_, i) => (i < correctCount ? correct : wrong));
}

describe('classifyTrend (spec G)', () => {
  it('is insufficient when either window is below the minimum', () => {
    expect(
      classifyTrend(outcomes(4, MIN_TREND_ATTEMPTS_PER_WINDOW - 1), outcomes(5, 5)).trend
    ).toBe('insufficient');
    expect(
      classifyTrend(outcomes(5, 5), outcomes(2, MIN_TREND_ATTEMPTS_PER_WINDOW - 1)).trend
    ).toBe('insufficient');
    expect(classifyTrend([], []).trend).toBe('insufficient');
  });

  it('classifies improving / declining / stable by the fixed delta', () => {
    expect(classifyTrend(outcomes(5, 5), outcomes(3, 5)).trend).toBe('improving');
    expect(classifyTrend(outcomes(2, 5), outcomes(4, 5)).trend).toBe('declining');
    expect(classifyTrend(outcomes(4, 5), outcomes(4, 5)).trend).toBe('stable');
  });

  it('does not overreact to a single question (spec G)', () => {
    // 10 vs 10: one extra miss moves accuracy by 0.1 < threshold.
    const result = classifyTrend(outcomes(8, 10), outcomes(9, 10));
    expect(TREND_DELTA_THRESHOLD).toBeGreaterThan(0.1);
    expect(result.trend).toBe('stable');
  });

  it('reports window accuracies and counts honestly', () => {
    const result = classifyTrend(outcomes(3, 6), outcomes(0, 0));
    expect(result.recentAccuracy).toBe(0.5);
    expect(result.previousAccuracy).toBeNull();
    expect(result.recentCount).toBe(6);
    expect(result.previousCount).toBe(0);
  });

  it('is deterministic for identical inputs', () => {
    const a = classifyTrend(outcomes(7, 9), outcomes(4, 8));
    const b = classifyTrend(outcomes(7, 9), outcomes(4, 8));
    expect(a).toEqual(b);
  });
});
