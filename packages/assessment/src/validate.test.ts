import {
  EVAL_FLAGGED_QUESTIONS,
  EVAL_GOOD_QUESTIONS,
  EVAL_REJECTED_QUESTIONS,
} from './evalFixtures';
import { RawGeneratedQuestion } from './schema';
import { validateGeneratedQuestion, validateGenerationBatch } from './validate';

const sba = EVAL_GOOD_QUESTIONS[0]!;
const sata = EVAL_GOOD_QUESTIONS[1]!;
const ordered = EVAL_GOOD_QUESTIONS[2]!;
const calc = EVAL_GOOD_QUESTIONS[3]!;

describe('validation pipeline — clean items (M7 spec K, quality eval spec AI)', () => {
  it('accepts every well-formed fixture as GENERATED with no flags', () => {
    for (const raw of EVAL_GOOD_QUESTIONS) {
      const result = validateGeneratedQuestion(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('generated');
        expect(result.value.safetyFlags).toEqual([]);
      }
    }
  });

  it('derives course_grounded from citations, never from the model claim (spec H)', () => {
    const grounded = validateGeneratedQuestion(sba);
    expect(grounded.ok && grounded.value.sourceType).toBe('course_grounded');
    const uncited = validateGeneratedQuestion({ ...sba, chunk_indexes: [] });
    expect(uncited.ok && uncited.value.sourceType).toBe('general_knowledge');
  });

  it('assigns deterministic 1-based option ordinals (spec B)', () => {
    const result = validateGeneratedQuestion(sata);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.options.map((option) => option.ordinal)).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it('keeps only known priority frameworks', () => {
    const result = validateGeneratedQuestion({
      ...sba,
      priority_frameworks: ['abc', 'maslow', 'abc'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.priorityFrameworks).toEqual(['abc']);
    }
  });
});

describe('validation pipeline — hard rejections (spec K)', () => {
  it('rejects every rejection fixture with reasons', () => {
    for (const raw of EVAL_REJECTED_QUESTIONS) {
      const result = validateGeneratedQuestion(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reasons.length).toBeGreaterThan(0);
      }
    }
  });

  it('single_best_answer must have exactly one correct option', () => {
    const none = validateGeneratedQuestion({
      ...sba,
      options: sba.options.map((option) => ({ ...option, is_correct: false })),
    });
    expect(none.ok).toBe(false);
  });

  it('multiple_response must be intentionally multi-correct, never all-correct', () => {
    const single = validateGeneratedQuestion({
      ...sata,
      options: sata.options.map((option, index) => ({ ...option, is_correct: index === 0 })),
    });
    expect(single.ok).toBe(false);
    const all = validateGeneratedQuestion({
      ...sata,
      options: sata.options.map((option) => ({ ...option, is_correct: true })),
    });
    expect(all.ok).toBe(false);
  });

  it('ordered_response requires correct_position covering 1..n exactly', () => {
    const broken = validateGeneratedQuestion({
      ...ordered,
      options: ordered.options.map((option, index) => ({
        ...option,
        correct_position: index === 0 ? 3 : option.correct_position, // duplicate 3, missing 1
      })),
    });
    expect(broken.ok).toBe(false);
  });

  it('numeric_calculation requires deterministic math data and forbids options', () => {
    expect(validateGeneratedQuestion({ ...calc, expected_value: null }).ok).toBe(false);
    expect(validateGeneratedQuestion({ ...calc, tolerance: null }).ok).toBe(false);
    expect(validateGeneratedQuestion({ ...calc, tolerance: -1 }).ok).toBe(false);
    expect(validateGeneratedQuestion({ ...calc, options: sba.options }).ok).toBe(false);
    // ...and non-numeric types must not smuggle numeric fields.
    expect(validateGeneratedQuestion({ ...sba, expected_value: 2, tolerance: 0 }).ok).toBe(false);
  });

  it('rejects duplicate options and answer leakage in the stem', () => {
    const duplicated = validateGeneratedQuestion({
      ...sba,
      options: sba.options.map((option, index) =>
        index === 1 ? { ...option, text: sba.options[0]!.text.toUpperCase() } : option
      ),
    });
    expect(duplicated.ok).toBe(false);
    const leaking = validateGeneratedQuestion({
      ...sba,
      stem: `${sba.stem} The best action is to administer intravenous calcium gluconate.`,
    });
    expect(leaking.ok).toBe(false);
  });
});

describe('validation pipeline — safety and distractor-quality flags (spec L/N)', () => {
  it('flags every flag fixture instead of activating or rejecting it', () => {
    for (const raw of EVAL_FLAGGED_QUESTIONS) {
      const result = validateGeneratedQuestion(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('flagged');
        expect(result.value.safetyFlags.length).toBeGreaterThan(0);
      }
    }
  });

  it('high-alert medication math without a unit is flagged (spec L)', () => {
    const result = validateGeneratedQuestion(EVAL_FLAGGED_QUESTIONS[0]!);
    expect(result.ok && result.value.safetyFlags).toContain('high_risk_missing_unit');
  });

  it('a wide tolerance on high-alert math is flagged (spec L)', () => {
    const result = validateGeneratedQuestion({
      ...EVAL_FLAGGED_QUESTIONS[0]!,
      answer_unit: 'mL/hr',
      tolerance: 2, // 40% of the expected 5 — far too loose for insulin
    });
    expect(result.ok && result.value.safetyFlags).toContain('high_risk_wide_tolerance');
  });

  it('absolute terms in options are flagged (spec N)', () => {
    const result = validateGeneratedQuestion(EVAL_FLAGGED_QUESTIONS[1]!);
    expect(result.ok && result.value.safetyFlags).toContain('absolute_term_option');
  });

  it('a conspicuously longest correct option is flagged (spec N)', () => {
    const result = validateGeneratedQuestion({
      ...sba,
      options: sba.options.map((option) =>
        option.is_correct
          ? {
              ...option,
              text:
                'Administer intravenous calcium gluconate per protocol while continuously ' +
                'monitoring the cardiac rhythm and preparing further potassium-lowering therapy',
            }
          : { ...option, text: option.text.slice(0, 30) }
      ),
    });
    expect(result.ok && result.value.safetyFlags).toContain('longest_option_correct');
  });

  it('missing distractor rationales are flagged, not rejected (spec M)', () => {
    const result = validateGeneratedQuestion({
      ...sba,
      options: sba.options.map((option) =>
        option.is_correct ? option : { ...option, rationale: '' }
      ),
    });
    expect(result.ok && result.value.safetyFlags).toContain('missing_distractor_rationale');
  });
});

describe('batch validation and in-batch dedup (spec R)', () => {
  it('separates accepted, rejected and duplicates', () => {
    const cosmeticTwin: RawGeneratedQuestion = {
      ...sba,
      stem: sba.stem.toUpperCase(),
    };
    const batch = validateGenerationBatch([
      ...EVAL_GOOD_QUESTIONS,
      cosmeticTwin,
      ...EVAL_REJECTED_QUESTIONS,
    ]);
    expect(batch.accepted).toHaveLength(EVAL_GOOD_QUESTIONS.length);
    expect(batch.duplicatesRemoved).toBe(1);
    expect(batch.rejected).toHaveLength(EVAL_REJECTED_QUESTIONS.length);
    for (const rejection of batch.rejected) {
      expect(rejection.reasons.length).toBeGreaterThan(0);
    }
  });

  it('legitimately different questions about the same concept both survive (spec R)', () => {
    const differentScenario: RawGeneratedQuestion = {
      ...sba,
      stem:
        'A client receiving intravenous fluids after a crush injury reports muscle weakness ' +
        'and has a serum potassium of 6.8 mEq/L. Which assessment should the nurse perform first?',
    };
    const batch = validateGenerationBatch([sba, differentScenario]);
    expect(batch.accepted).toHaveLength(2);
    expect(batch.duplicatesRemoved).toBe(0);
  });

  it('is byte-identical across repeated runs (repeatable quality eval, spec AI)', () => {
    const first = validateGenerationBatch(EVAL_GOOD_QUESTIONS);
    const second = validateGenerationBatch(EVAL_GOOD_QUESTIONS);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
