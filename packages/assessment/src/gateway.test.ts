import { AiRouterEvent, setAiRouterEventSink } from '@avidia/ai-router';

import {
  EVAL_GENERATION_CHUNKS,
  EVAL_GENERATION_CONCEPTS,
  EVAL_GOOD_QUESTIONS,
} from './evalFixtures';
import {
  OPENAI_QUESTION_MODEL,
  OpenAIQuestionGenerationProvider,
  QuestionGenerationFailedError,
  ScriptedQuestionGenerationProvider,
  createQuestionGenerationProviderFromEnv,
} from './gateway';
import { validateGenerationBatch } from './validate';

const okResponse = (body: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }), {
    status: 200,
  });

const noSleep = () => Promise.resolve();

describe('OpenAI question generation provider (M7 spec I/J/AE)', () => {
  it('sends constrained JSON schema and returns validated questions', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenAIQuestionGenerationProvider(
      'key',
      'gpt-4o-mini',
      async (_url, init) => {
        bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
        return okResponse({ questions: EVAL_GOOD_QUESTIONS });
      },
      noSleep
    );
    const result = await provider.generate(EVAL_GENERATION_CONCEPTS, EVAL_GENERATION_CHUNKS);
    expect(result.questions).toHaveLength(EVAL_GOOD_QUESTIONS.length);
    expect(bodies[0]!.temperature).toBe(0);
    const format = bodies[0]!.response_format as {
      type: string;
      json_schema: { strict: boolean; name: string };
    };
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.name).toBe('question_generation');
  });

  it('runs exactly one repair round naming the violations', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    const provider = new OpenAIQuestionGenerationProvider(
      'key',
      'gpt-4o-mini',
      async (_url, init) => {
        bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
        call += 1;
        if (call === 1) {
          return okResponse({ questions: [{ broken: true }] });
        }
        return okResponse({ questions: EVAL_GOOD_QUESTIONS });
      },
      noSleep
    );
    const result = await provider.generate(EVAL_GENERATION_CONCEPTS, EVAL_GENERATION_CHUNKS);
    expect(result.questions).toHaveLength(EVAL_GOOD_QUESTIONS.length);
    const repair = bodies[1]!.messages as Array<{ role: string; content: string }>;
    expect(repair).toHaveLength(4);
    expect(repair[2]!.role).toBe('assistant');
    expect(repair[3]!.content).toContain('violated the required schema');
  });

  it('fails hard when the repair round is still invalid', async () => {
    const provider = new OpenAIQuestionGenerationProvider(
      'key',
      'gpt-4o-mini',
      async () => okResponse({ questions: [{ broken: true }] }),
      noSleep
    );
    await expect(
      provider.generate(EVAL_GENERATION_CONCEPTS, EVAL_GENERATION_CHUNKS)
    ).rejects.toThrow(QuestionGenerationFailedError);
  });

  it('retries 429/5xx with backoff and fails fast on other 4xx', async () => {
    let attempts = 0;
    const flaky = new OpenAIQuestionGenerationProvider(
      'key',
      'gpt-4o-mini',
      async () => {
        attempts += 1;
        if (attempts < 3) {
          return new Response('rate limited', { status: 429 });
        }
        return okResponse({ questions: EVAL_GOOD_QUESTIONS });
      },
      noSleep
    );
    await expect(
      flaky.generate(EVAL_GENERATION_CONCEPTS, EVAL_GENERATION_CHUNKS)
    ).resolves.toBeTruthy();
    expect(attempts).toBe(3);

    let badRequests = 0;
    const rejected = new OpenAIQuestionGenerationProvider(
      'key',
      'gpt-4o-mini',
      async () => {
        badRequests += 1;
        return new Response('bad request', { status: 400 });
      },
      noSleep
    );
    await expect(
      rejected.generate(EVAL_GENERATION_CONCEPTS, EVAL_GENERATION_CHUNKS)
    ).rejects.toThrow(QuestionGenerationFailedError);
    expect(badRequests).toBe(1);
  });

  it('makes no request for empty inputs', async () => {
    let calls = 0;
    const provider = new OpenAIQuestionGenerationProvider(
      'key',
      'gpt-4o-mini',
      async () => {
        calls += 1;
        return okResponse({ questions: [] });
      },
      noSleep
    );
    await expect(provider.generate([], EVAL_GENERATION_CHUNKS)).resolves.toEqual({ questions: [] });
    await expect(provider.generate(EVAL_GENERATION_CONCEPTS, [])).resolves.toEqual({
      questions: [],
    });
    expect(calls).toBe(0);
  });

  describe('AI router observability (spec section 8)', () => {
    const events: AiRouterEvent[] = [];
    let previousSink: ReturnType<typeof setAiRouterEventSink>;

    beforeEach(() => {
      events.length = 0;
      previousSink = setAiRouterEventSink((event) => events.push(event));
    });

    afterEach(() => {
      setAiRouterEventSink(previousSink);
    });

    it('emits one privacy-safe QUESTION_GENERATION_ROUTINE event per call, carrying no concept/chunk/stem content', async () => {
      const provider = new OpenAIQuestionGenerationProvider(
        'key',
        OPENAI_QUESTION_MODEL,
        async () => okResponse({ questions: EVAL_GOOD_QUESTIONS }),
        noSleep
      );
      await provider.generate(EVAL_GENERATION_CONCEPTS, EVAL_GENERATION_CHUNKS);

      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event).toMatchObject({
        task: 'QUESTION_GENERATION_ROUTINE',
        tier: 'ECONOMY',
        provider: 'openai',
        model: OPENAI_QUESTION_MODEL,
        success: true,
      });
      expect(typeof event!.latencyMs).toBe('number');
      const stems = EVAL_GOOD_QUESTIONS.map((q) => q.stem).filter(Boolean);
      for (const stem of stems) {
        expect(JSON.stringify(event)).not.toContain(stem);
      }
    });

    it('emits a failure event when generation fails', async () => {
      const provider = new OpenAIQuestionGenerationProvider(
        'key',
        OPENAI_QUESTION_MODEL,
        async () => new Response('bad request', { status: 400 }),
        noSleep
      );
      await expect(
        provider.generate(EVAL_GENERATION_CONCEPTS, EVAL_GENERATION_CHUNKS)
      ).rejects.toThrow(QuestionGenerationFailedError);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        task: 'QUESTION_GENERATION_ROUTINE',
        success: false,
        failureReason: '400',
      });
    });
  });
});

describe('scripted provider (keyless dev/test seam)', () => {
  it('generates schema-valid questions only for concepts evidenced in chunks', async () => {
    const provider = new ScriptedQuestionGenerationProvider();
    const result = await provider.generate(
      [
        ...EVAL_GENERATION_CONCEPTS,
        { key: 'sepsis', name: 'Sepsis', type: 'disease_disorder', emphasisScore: 1 },
      ],
      EVAL_GENERATION_CHUNKS
    );
    const keys = new Set(result.questions.map((question) => question.concept_key));
    expect(keys.has('hyperkalemia')).toBe(true);
    expect(keys.has('sepsis')).toBe(false); // not in the chunks → no question
    // Medication concepts also yield a deterministic calculation.
    expect(
      result.questions.some(
        (question) =>
          question.concept_key === 'furosemide' && question.question_type === 'numeric_calculation'
      )
    ).toBe(true);
  });

  it('output passes the full validation pipeline and is deterministic', async () => {
    const provider = new ScriptedQuestionGenerationProvider();
    const first = await provider.generate(EVAL_GENERATION_CONCEPTS, EVAL_GENERATION_CHUNKS);
    const second = await provider.generate(EVAL_GENERATION_CONCEPTS, EVAL_GENERATION_CHUNKS);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const batch = validateGenerationBatch(first.questions);
    expect(batch.rejected).toEqual([]);
    expect(batch.accepted.length).toBe(first.questions.length);
  });
});

describe('provider selection from environment (spec I)', () => {
  it('selects openai with a key, scripted explicitly, and fails otherwise', () => {
    expect(
      createQuestionGenerationProviderFromEnv({
        QUESTION_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
      }).metadata().provider
    ).toBe('openai');
    expect(
      createQuestionGenerationProviderFromEnv({ QUESTION_PROVIDER: 'scripted' }).metadata().provider
    ).toBe('scripted');
    expect(() => createQuestionGenerationProviderFromEnv({ QUESTION_PROVIDER: 'openai' })).toThrow(
      /OPENAI_API_KEY/
    );
    expect(() => createQuestionGenerationProviderFromEnv({ QUESTION_PROVIDER: 'nope' })).toThrow(
      /Unknown QUESTION_PROVIDER/
    );
  });
});
