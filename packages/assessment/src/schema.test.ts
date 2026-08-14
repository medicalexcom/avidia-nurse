import { EVAL_GOOD_QUESTIONS } from './evalFixtures';
import { MAX_QUESTIONS_PER_BATCH, validateGeneration } from './schema';

const wrap = (questions: unknown) => ({ questions });

describe('generation schema validation (M7 spec J)', () => {
  it('accepts a well-formed batch', () => {
    const result = validateGeneration(wrap(EVAL_GOOD_QUESTIONS), 4);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.questions).toHaveLength(EVAL_GOOD_QUESTIONS.length);
    }
  });

  it('rejects non-object responses outright', () => {
    for (const raw of [null, 'text', 42, ['a']]) {
      const result = validateGeneration(raw, 4);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects unknown question types, difficulties and cognitive levels', () => {
    const base = EVAL_GOOD_QUESTIONS[0]!;
    for (const broken of [
      { ...base, question_type: 'true_false' },
      { ...base, difficulty: 'medium' },
      { ...base, cognitive_level: 'evaluation' },
    ]) {
      const result = validateGeneration(wrap([broken]), 4);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects short stems and missing rationales', () => {
    const base = EVAL_GOOD_QUESTIONS[0]!;
    expect(validateGeneration(wrap([{ ...base, stem: 'Too short' }]), 4).ok).toBe(false);
    expect(validateGeneration(wrap([{ ...base, rationale: '' }]), 4).ok).toBe(false);
  });

  it('bounds chunk citations to the submitted batch', () => {
    const base = EVAL_GOOD_QUESTIONS[0]!;
    expect(validateGeneration(wrap([{ ...base, chunk_indexes: [4] }]), 4).ok).toBe(false);
    expect(validateGeneration(wrap([{ ...base, chunk_indexes: [-1] }]), 4).ok).toBe(false);
    expect(validateGeneration(wrap([{ ...base, chunk_indexes: [3] }]), 4).ok).toBe(true);
  });

  it('rejects malformed options', () => {
    const base = EVAL_GOOD_QUESTIONS[0]!;
    const brokenOption = { ...base.options[0]!, is_correct: 'yes' };
    const result = validateGeneration(
      wrap([{ ...base, options: [brokenOption, ...base.options.slice(1)] }]),
      4
    );
    expect(result.ok).toBe(false);
  });

  it('caps batch size', () => {
    const base = EVAL_GOOD_QUESTIONS[0]!;
    const flood = Array.from({ length: MAX_QUESTIONS_PER_BATCH + 1 }, () => base);
    expect(validateGeneration(wrap(flood), 4).ok).toBe(false);
  });

  it('collects multiple errors instead of stopping at the first', () => {
    const base = EVAL_GOOD_QUESTIONS[0]!;
    const result = validateGeneration(
      wrap([{ ...base, stem: 'x', difficulty: 'medium', chunk_indexes: [9] }]),
      4
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});
