import { isMeaninglessConceptName, normalizeConceptKey } from './normalize';

describe('normalizeConceptKey', () => {
  it('folds case, punctuation, and whitespace deterministically', () => {
    expect(normalizeConceptKey('Diabetic Ketoacidosis')).toBe('diabetic ketoacidosis');
    expect(normalizeConceptKey('  diabetic   ketoacidosis ')).toBe('diabetic ketoacidosis');
    expect(normalizeConceptKey('D.K.A.')).toBe('d k a');
    expect(normalizeConceptKey('beta-blocker')).toBe(normalizeConceptKey('beta blocker'));
  });

  it('applies Unicode compatibility folding', () => {
    // Fullwidth letters fold to ASCII under NFKC.
    expect(normalizeConceptKey('ＣＯＰＤ')).toBe('copd');
  });

  it('never folds letters themselves — clinical near-twins stay distinct', () => {
    expect(normalizeConceptKey('Hyperkalemia')).not.toBe(normalizeConceptKey('Hypokalemia'));
    expect(normalizeConceptKey('hypoglycemia')).not.toBe(normalizeConceptKey('hyperglycemia'));
  });

  it('keeps digits (dosages, ranges)', () => {
    expect(normalizeConceptKey('Oxygen Titration 88-92%')).toBe('oxygen titration 88 92');
  });
});

describe('isMeaninglessConceptName', () => {
  it('drops generic standalone words', () => {
    expect(isMeaninglessConceptName('Patient')).toBe(true);
    expect(isMeaninglessConceptName('blood')).toBe(true);
    expect(isMeaninglessConceptName('Hospital')).toBe(true);
  });

  it('drops phrases made entirely of generic words', () => {
    expect(isMeaninglessConceptName('patient care')).toBe(true);
    expect(isMeaninglessConceptName('Nursing Assessment')).toBe(true);
  });

  it('keeps specific phrases that contain a generic word', () => {
    expect(isMeaninglessConceptName('Heart Failure')).toBe(false);
    expect(isMeaninglessConceptName('Blood Transfusion Reaction')).toBe(false);
    expect(isMeaninglessConceptName('Patient-Controlled Analgesia')).toBe(false);
  });

  it('keeps real clinical concepts', () => {
    expect(isMeaninglessConceptName('Hyperkalemia')).toBe(false);
    expect(isMeaninglessConceptName('Furosemide')).toBe(false);
  });

  it('drops names that are too short, too long, or letterless', () => {
    expect(isMeaninglessConceptName('a')).toBe(true);
    expect(isMeaninglessConceptName('x'.repeat(300))).toBe(true);
    expect(isMeaninglessConceptName('88-92')).toBe(true);
    expect(isMeaninglessConceptName('!!!')).toBe(true);
  });
});
