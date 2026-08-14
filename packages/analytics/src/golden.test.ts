/**
 * Golden tests — M12 (spec AS/AT): the five synthetic students produce the
 * expected interpretations end-to-end through `getCourseAnalytics`, and the
 * whole pipeline is deterministic (identical input → identical output).
 */

import { getCourseAnalytics } from './overview';
import { resetFixtureIds, studentA, studentB, studentC, studentD, studentE } from './fixtures';

beforeEach(resetFixtureIds);

describe('synthetic students (spec AS)', () => {
  it('A — strong recall, weak prioritization shows in the level breakdown', () => {
    resetFixtureIds();
    const result = getCourseAnalytics(studentA());
    const recall = result.cognitiveLevels.find((r) => r.key === 'recall')!;
    const prioritization = result.cognitiveLevels.find((r) => r.key === 'prioritization')!;
    expect(recall.accuracy!.accuracy).toBeGreaterThan(0.85);
    expect(prioritization.accuracy!.accuracy).toBeLessThan(0.5);
    // Clinical judgment mirrors the same honest split.
    expect(result.clinicalJudgment.prioritizationQuestions.accuracy!.accuracy).toBeLessThan(0.5);
  });

  it('B — high accuracy on 30% coverage is NOT readiness (spec O/Q)', () => {
    resetFixtureIds();
    const result = getCourseAnalytics(studentB());
    expect(result.readiness.state).toBe('building');
    expect(result.readiness.reasons).toContain('low_coverage');
    expect(result.readiness.assessedCoverage).toBeCloseTo(0.3);
    // Mastery on the assessed slice is honestly reported as strong.
    expect(result.readiness.strongShareOfAssessed).toBe(1);
    // The distribution shows the truth: most concepts unassessed.
    expect(result.distribution.distribution.unassessed).toBe(7);
  });

  it('C — repeated certain-and-incorrect raises the misconception signal (spec L/M)', () => {
    resetFixtureIds();
    const result = getCourseAnalytics(studentC());
    expect(result.calibration.overconfidenceSignal).toBe(true);
    const flagged = result.conceptAnalytics.needsAttention.find((c) => c.conceptId === 'c-1')!;
    expect(flagged.misconceptionSignal).toBe(true);
    expect(flagged.attentionReasons[0]).toBe('misconception_signal');
    expect(result.errorPatterns.map((p) => p.code)).toContain('high_confidence_misses');
    // Supportive, non-punitive language only.
    const messages = result.insights.map((i) => i.message).join(' ');
    expect(messages).not.toMatch(/fail|bad|wrong with you|poor/i);
  });

  it('D — simulations show strong cue recognition, weak reassessment (spec Y/AA)', () => {
    resetFixtureIds();
    const result = getCourseAnalytics(studentD());
    expect(result.simulation.completedCount).toBe(3);
    expect(result.simulation.weakestDimension?.dimension).toBe('evaluate_outcomes');
    const cues = result.simulation.dimensions.find((d) => d.dimension === 'recognize_cues')!;
    expect(cues.share).toBe(1);
    expect(result.simulation.outcomes.deteriorated).toBe(1);
    // No question attempts: question-side panels stay honestly empty.
    expect(result.clinicalJudgment.prioritizationQuestions.attempts).toBe(0);
  });

  it('E — zero attempts: empty state, unassessed never reads as weak (spec H/AI)', () => {
    resetFixtureIds();
    const result = getCourseAnalytics(studentE());
    expect(result.isEmpty).toBe(true);
    expect(result.conceptAnalytics.needsAttention).toHaveLength(0);
    expect(result.distribution.distribution.unassessed).toBe(10);
    expect(result.distribution.distribution.needs_review).toBe(0);
    expect(result.readiness.state).toBe('early');
    expect(result.weekOverWeek.trend).toBe('insufficient');
    expect(result.consistency.streakDays).toBe(0);
    // The empty state still offers a way forward (spec AC/AI).
    expect(result.insights.length).toBeGreaterThan(0);
    expect(result.insights[0]!.action).toEqual({ kind: 'adaptive_session' });
  });
});

describe('determinism (spec AT)', () => {
  it('identical input produces identical output, three runs', () => {
    resetFixtureIds();
    const a = getCourseAnalytics(studentA());
    resetFixtureIds();
    const b = getCourseAnalytics(studentA());
    resetFixtureIds();
    const c = getCourseAnalytics(studentA());
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
    expect(JSON.stringify(b)).toEqual(JSON.stringify(c));
  });
});
