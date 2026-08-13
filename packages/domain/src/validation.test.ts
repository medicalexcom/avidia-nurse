import {
  moveItem,
  resequence,
  validateCourse,
  validateExam,
  validateModuleTitle,
} from './validation';

describe('validateCourse', () => {
  it('accepts a minimal course and trims fields', () => {
    const result = validateCourse({ title: '  Pharmacology  ', term: ' Fall 2026 ' });
    expect(result).toEqual({
      ok: true,
      value: { title: 'Pharmacology', term: 'Fall 2026', institution_name: null },
    });
  });

  it('requires a non-blank title', () => {
    const result = validateCourse({ title: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('Course title is required.');
  });

  it('rejects over-long fields', () => {
    const result = validateCourse({
      title: 'x'.repeat(121),
      term: 'y'.repeat(61),
      institutionName: 'z'.repeat(121),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(3);
  });
});

describe('validateModuleTitle', () => {
  it('trims and accepts a title', () => {
    expect(validateModuleTitle('  Cardiac  ')).toEqual({ ok: true, value: 'Cardiac' });
  });

  it('rejects blank and over-long titles', () => {
    expect(validateModuleTitle('  ').ok).toBe(false);
    expect(validateModuleTitle('x'.repeat(121)).ok).toBe(false);
  });
});

describe('validateExam', () => {
  const examAt = new Date('2026-09-04T14:00:00Z');

  it('accepts a valid exam with optional weight', () => {
    const result = validateExam({ title: ' Exam 1 ', examAt, weightText: ' 25 ' });
    expect(result).toEqual({
      ok: true,
      value: { title: 'Exam 1', exam_at: '2026-09-04T14:00:00.000Z', weight: 25 },
    });
  });

  it('treats an empty weight as null', () => {
    const result = validateExam({ title: 'Exam 1', examAt, weightText: '' });
    expect(result.ok && result.value.weight).toBeNull();
  });

  it('rejects missing title, invalid date, and out-of-range weight', () => {
    const bad = validateExam({ title: ' ', examAt: null, weightText: '150' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors).toEqual(
        expect.arrayContaining([
          'Exam title is required.',
          'Enter a valid exam date and time.',
          'Weight must be a number between 0 and 100.',
        ])
      );
    }
    expect(validateExam({ title: 'E', examAt, weightText: 'abc' }).ok).toBe(false);
    expect(validateExam({ title: 'E', examAt, weightText: '-1' }).ok).toBe(false);
  });

  it('accepts historical exam dates without crashing (handled by countdown, not rejected)', () => {
    const past = validateExam({ title: 'Final', examAt: new Date('2020-01-01T00:00:00Z') });
    expect(past.ok).toBe(true);
  });
});

describe('module ordering helpers', () => {
  const modules = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('assigns gapless sequences in display order', () => {
    expect(resequence(modules)).toEqual([
      { id: 'a', sequence: 0 },
      { id: 'b', sequence: 1 },
      { id: 'c', sequence: 2 },
    ]);
  });

  it('moves items and ignores out-of-range moves', () => {
    expect(moveItem(modules, 2, 0).map((m) => m.id)).toEqual(['c', 'a', 'b']);
    expect(moveItem(modules, 0, 1).map((m) => m.id)).toEqual(['b', 'a', 'c']);
    expect(moveItem(modules, 5, 0).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});
