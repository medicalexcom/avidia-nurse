import { EVAL_GENERATION_CHUNKS, EVAL_GOOD_QUESTIONS } from './evalFixtures';
import { toQuestionRpcPayload } from './rpc';
import { validateGenerationBatch } from './validate';

const metadata = {
  provider: 'scripted',
  model: 'scripted-v1',
  promptVersion: 'p1',
  generationVersion: 'v1',
};

describe('RPC payload mapping (M7 spec G/J/Q)', () => {
  it('maps validated questions to snake_case entries with resolved chunk ids', () => {
    const batch = validateGenerationBatch(EVAL_GOOD_QUESTIONS);
    const payload = toQuestionRpcPayload(batch.accepted, EVAL_GENERATION_CHUNKS, metadata);
    expect(payload.generation).toEqual({
      provider: 'scripted',
      model: 'scripted-v1',
      prompt_version: 'p1',
      generation_version: 'v1',
    });
    expect(payload.questions).toHaveLength(batch.accepted.length);
    const first = payload.questions[0]!;
    expect(first.content_hash).toBe(batch.accepted[0]!.contentHash);
    expect(first.status).toBe('active');
    // chunk_indexes resolve to the actual chunk UUIDs (spec Q).
    for (const question of payload.questions) {
      for (const chunkId of question.chunk_ids) {
        expect(EVAL_GENERATION_CHUNKS.map((chunk) => chunk.id)).toContain(chunkId);
      }
    }
    // Options keep deterministic ordinals and per-option truths.
    const withOptions = payload.questions.find((question) => question.options.length > 0)!;
    expect(withOptions.options.map((option) => option.ordinal)).toEqual(
      withOptions.options.map((_, index) => index + 1)
    );
  });

  it('drops out-of-range chunk indexes instead of sending garbage ids', () => {
    const batch = validateGenerationBatch([EVAL_GOOD_QUESTIONS[0]!]);
    const doctored = [{ ...batch.accepted[0]!, chunkIndexes: [0, 99] }];
    const payload = toQuestionRpcPayload(doctored, EVAL_GENERATION_CHUNKS, metadata);
    expect(payload.questions[0]!.chunk_ids).toEqual([EVAL_GENERATION_CHUNKS[0]!.id]);
  });
});
