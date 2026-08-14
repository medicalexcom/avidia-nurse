import { cellFor, computeCalibration } from './calibration';
import { MIN_CALIBRATION_ATTEMPTS } from './thresholds';
import { attempt, resetFixtureIds } from './fixtures';

beforeEach(resetFixtureIds);

describe('confidence calibration (spec L)', () => {
  it('maps the four cells correctly', () => {
    expect(cellFor(true, 'certain')).toBe('calibrated_confident');
    expect(cellFor(true, 'pretty_sure')).toBe('calibrated_confident');
    expect(cellFor(true, 'unsure')).toBe('underconfident');
    expect(cellFor(true, 'guessing')).toBe('underconfident');
    expect(cellFor(false, 'certain')).toBe('overconfident');
    expect(cellFor(false, 'pretty_sure')).toBe('overconfident');
    expect(cellFor(false, 'unsure')).toBe('aware_gap');
    expect(cellFor(false, 'guessing')).toBe('aware_gap');
  });

  it('excludes untagged attempts and reports their count honestly', () => {
    const result = computeCalibration([
      attempt({ confidence: null, isCorrect: true }),
      attempt({ confidence: 'certain', isCorrect: true }),
    ]);
    expect(result.taggedCount).toBe(1);
    expect(result.untaggedCount).toBe(1);
  });

  it('says nothing before the evidence gate (spec AJ)', () => {
    const few = Array.from({ length: MIN_CALIBRATION_ATTEMPTS - 1 }, () =>
      attempt({ confidence: 'certain', isCorrect: false })
    );
    const result = computeCalibration(few);
    expect(result.sufficient).toBe(false);
    expect(result.calibratedShare).toBeNull();
    expect(result.overconfidenceSignal).toBe(false);
  });

  it('flags an overconfidence SIGNAL after repeated certain misses', () => {
    const attempts = [
      ...Array.from({ length: 8 }, () => attempt({ confidence: 'pretty_sure', isCorrect: true })),
      ...Array.from({ length: 3 }, () => attempt({ confidence: 'certain', isCorrect: false })),
    ];
    const result = computeCalibration(attempts);
    expect(result.sufficient).toBe(true);
    expect(result.overconfidenceSignal).toBe(true);
    expect(result.cells.overconfident).toBe(3);
    expect(result.calibratedShare).toBeCloseTo(8 / 11);
  });

  it('does not flag a single high-confidence miss', () => {
    const attempts = [
      ...Array.from({ length: 10 }, () => attempt({ confidence: 'unsure', isCorrect: true })),
      attempt({ confidence: 'certain', isCorrect: false }),
    ];
    expect(computeCalibration(attempts).overconfidenceSignal).toBe(false);
  });
});
