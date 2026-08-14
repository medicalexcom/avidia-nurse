import { scoreChoiceResponse, scoreNumericResponse, scoreOrderedResponse } from './score';

describe('deterministic scoring (M7 spec P/V — mirror of submit_question_attempt SQL)', () => {
  it('single/multiple choice: set equality, order-independent', () => {
    expect(scoreChoiceResponse(['a'], ['a'])).toBe(true);
    expect(scoreChoiceResponse(['b'], ['a'])).toBe(false);
    expect(scoreChoiceResponse(['b', 'a'], ['a', 'b'])).toBe(true);
    // Partial credit does not exist: missing or extra selections are wrong.
    expect(scoreChoiceResponse(['a'], ['a', 'b'])).toBe(false);
    expect(scoreChoiceResponse(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
    expect(scoreChoiceResponse([], ['a'])).toBe(false);
  });

  it('ordered response: exact sequence equality', () => {
    expect(scoreOrderedResponse(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(true);
    expect(scoreOrderedResponse(['b', 'a', 'c'], ['a', 'b', 'c'])).toBe(false);
    expect(scoreOrderedResponse(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
  });

  it('numeric: correct within the stored tolerance, no LLM arithmetic', () => {
    expect(scoreNumericResponse(2, 2, 0)).toBe(true);
    expect(scoreNumericResponse(2.05, 2, 0.1)).toBe(true);
    expect(scoreNumericResponse(2.2, 2, 0.1)).toBe(false);
    expect(scoreNumericResponse(1, 2, 0)).toBe(false);
    expect(scoreNumericResponse(Number.NaN, 2, 1)).toBe(false);
    expect(scoreNumericResponse(Number.POSITIVE_INFINITY, 2, 1)).toBe(false);
  });
});
