import { computeQuestionContentHash, normalizeQuestionText } from './hash';

describe('question content hashing (M7 spec R)', () => {
  it('normalization folds case, punctuation and whitespace only (dots kept for decimals)', () => {
    expect(normalizeQuestionText('  Serum   K+ of 6.4 mEq/L!  ')).toBe('serum k of 6.4 meq l');
    // Letters are never altered: clinically opposite twins stay distinct.
    expect(normalizeQuestionText('hyperkalemia')).not.toBe(normalizeQuestionText('hypokalemia'));
  });

  it('cosmetic differences collapse to the same hash', () => {
    const a = computeQuestionContentHash('single_best_answer', 'Which action FIRST?  Assess now.', [
      'Option A',
      'Option B',
    ]);
    const b = computeQuestionContentHash('single_best_answer', 'which action first? assess now.', [
      'option b', // order-independent
      'option a',
    ]);
    expect(a).toBe(b);
  });

  it('different content or type produces different hashes', () => {
    const base = computeQuestionContentHash('single_best_answer', 'A stem about potassium', ['x']);
    expect(
      computeQuestionContentHash('multiple_response', 'A stem about potassium', ['x'])
    ).not.toBe(base);
    expect(computeQuestionContentHash('single_best_answer', 'A stem about sodium', ['x'])).not.toBe(
      base
    );
    expect(
      computeQuestionContentHash('single_best_answer', 'A stem about potassium', ['y'])
    ).not.toBe(base);
  });
});
