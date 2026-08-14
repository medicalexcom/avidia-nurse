/**
 * Deterministic scoring (M7 spec P/V, ADR-0020).
 *
 * The AUTHORITATIVE scorer is the `submit_question_attempt` SQL function
 * (migration 0007) — clients can never compute or forge correctness. These
 * functions are the exact TypeScript mirror of that SQL, used by the test
 * suite to pin the scoring semantics and by any future server-side consumer.
 * If one changes, the other must change with it (tests assert the contract).
 */

/** Set equality on option ids — selection order never matters. */
export function scoreChoiceResponse(
  selectedOptionIds: readonly string[],
  correctOptionIds: readonly string[]
): boolean {
  if (selectedOptionIds.length !== correctOptionIds.length) {
    return false;
  }
  const selected = [...selectedOptionIds].sort();
  const correct = [...correctOptionIds].sort();
  return selected.every((id, index) => id === correct[index]);
}

/** Exact sequence equality against the correct order. */
export function scoreOrderedResponse(
  orderedOptionIds: readonly string[],
  correctOrder: readonly string[]
): boolean {
  return (
    orderedOptionIds.length === correctOrder.length &&
    orderedOptionIds.every((id, index) => id === correctOrder[index])
  );
}

/**
 * Numeric answers are correct within the question's stored tolerance
 * (spec P): |value − expected| ≤ tolerance. The expected value and tolerance
 * are DATA produced at generation time and validated — never arithmetic
 * performed by a language model at answer time.
 */
export function scoreNumericResponse(
  value: number,
  expectedValue: number,
  tolerance: number
): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }
  return Math.abs(value - expectedValue) <= tolerance;
}
