import { AiRouterEvent, setAiRouterEventSink } from '@avidia/ai-router';

import { EVAL_EXTRACTION_CHUNKS } from './evalFixtures';
import {
  CONCEPT_EXTRACTION_SYSTEM_PROMPT,
  CONCEPT_EXTRACTION_VERSION,
  CONCEPT_PROMPT_VERSION,
  ConceptExtractionFailedError,
  OPENAI_CONCEPT_MODEL,
  OpenAIConceptExtractionProvider,
  ScriptedConceptExtractionProvider,
  createConceptExtractionProviderFromEnv,
} from './gateway';
import { RawExtraction } from './schema';

const noSleep = () => Promise.resolve();

const validExtraction: RawExtraction = {
  concepts: [{ name: 'Hyperkalemia', type: 'laboratory', aliases: [], chunk_indexes: [0] }],
  relationships: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function chatResponse(content: unknown, status = 200): Response {
  return jsonResponse(
    {
      choices: [
        {
          message: {
            content: typeof content === 'string' ? content : JSON.stringify(content),
          },
        },
      ],
    },
    status
  );
}

const chunks = [
  { id: 'c0', locator: 'slide 3 — Potassium', content: 'Hyperkalemia causes peaked T waves.' },
];

describe('OpenAIConceptExtractionProvider', () => {
  it('reports provider metadata with versions for auditability', () => {
    const provider = new OpenAIConceptExtractionProvider('key');
    expect(provider.metadata()).toEqual({
      provider: 'openai',
      model: OPENAI_CONCEPT_MODEL,
      promptVersion: CONCEPT_PROMPT_VERSION,
      extractionVersion: CONCEPT_EXTRACTION_VERSION,
    });
  });

  it('sends the grounded system prompt, indexed chunks, and strict JSON schema', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const provider = new OpenAIConceptExtractionProvider(
      'secret-key',
      OPENAI_CONCEPT_MODEL,
      (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(chatResponse(validExtraction));
      },
      noSleep
    );
    const result = await provider.extract(chunks);
    expect(result).toEqual(validExtraction);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-key');
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.model).toBe(OPENAI_CONCEPT_MODEL);
    expect(body.temperature).toBe(0);
    expect(body.messages[0]).toEqual({
      role: 'system',
      content: CONCEPT_EXTRACTION_SYSTEM_PROMPT,
    });
    expect(body.messages[1].content).toContain('[0] (slide 3 — Potassium)');
    expect(body.messages[1].content).toContain('Hyperkalemia causes peaked T waves.');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
  });

  it('returns an empty extraction without any network call for an empty batch', async () => {
    const fetchFn = jest.fn();
    const provider = new OpenAIConceptExtractionProvider(
      'key',
      OPENAI_CONCEPT_MODEL,
      fetchFn,
      noSleep
    );
    await expect(provider.extract([])).resolves.toEqual({ concepts: [], relationships: [] });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('runs one controlled repair round naming the schema violations', async () => {
    const invalid = {
      concepts: [{ name: '', type: 'laboratory', aliases: [], chunk_indexes: [] }],
    };
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    const provider = new OpenAIConceptExtractionProvider(
      'key',
      OPENAI_CONCEPT_MODEL,
      (_url, init) => {
        bodies.push(JSON.parse(init!.body as string));
        call += 1;
        return Promise.resolve(chatResponse(call === 1 ? invalid : validExtraction));
      },
      noSleep
    );
    await expect(provider.extract(chunks)).resolves.toEqual(validExtraction);
    expect(bodies).toHaveLength(2);
    const repair = bodies[1]!.messages as Array<{ role: string; content: string }>;
    expect(repair[2]).toEqual({ role: 'assistant', content: JSON.stringify(invalid) });
    expect(repair[3]!.content).toContain('violated the required schema');
    expect(repair[3]!.content).toContain('name');
  });

  it('fails with ConceptExtractionFailedError when repair also returns invalid output', async () => {
    const invalid = { concepts: 'nope' };
    const provider = new OpenAIConceptExtractionProvider(
      'key',
      OPENAI_CONCEPT_MODEL,
      () => Promise.resolve(chatResponse(invalid)),
      noSleep
    );
    await expect(provider.extract(chunks)).rejects.toThrow(
      'structured output invalid after repair'
    );
  });

  it('routes non-JSON content through the repair round instead of crashing', async () => {
    let call = 0;
    const provider = new OpenAIConceptExtractionProvider(
      'key',
      OPENAI_CONCEPT_MODEL,
      () => {
        call += 1;
        return Promise.resolve(
          call === 1 ? chatResponse('Sorry, I cannot do that.') : chatResponse(validExtraction)
        );
      },
      noSleep
    );
    await expect(provider.extract(chunks)).resolves.toEqual(validExtraction);
  });

  it('retries 429 and 5xx with backoff, then succeeds', async () => {
    const sleeps: number[] = [];
    let call = 0;
    const provider = new OpenAIConceptExtractionProvider(
      'key',
      OPENAI_CONCEPT_MODEL,
      () => {
        call += 1;
        if (call === 1) return Promise.resolve(jsonResponse({}, 429));
        if (call === 2) return Promise.resolve(jsonResponse({}, 500));
        return Promise.resolve(chatResponse(validExtraction));
      },
      (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      }
    );
    await expect(provider.extract(chunks)).resolves.toEqual(validExtraction);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('retries network errors and surfaces the last failure after max attempts', async () => {
    const provider = new OpenAIConceptExtractionProvider(
      'key',
      OPENAI_CONCEPT_MODEL,
      () => Promise.reject(new Error('socket hang up')),
      noSleep
    );
    await expect(provider.extract(chunks)).rejects.toThrow('network error: socket hang up');
  });

  it('fails fast on non-retryable 4xx such as 401', async () => {
    const fetchFn = jest.fn(() => Promise.resolve(jsonResponse({}, 401)));
    const provider = new OpenAIConceptExtractionProvider(
      'bad',
      OPENAI_CONCEPT_MODEL,
      fetchFn,
      noSleep
    );
    await expect(provider.extract(chunks)).rejects.toThrow(
      'extraction request failed with status 401'
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries on persistent 429s', async () => {
    const fetchFn = jest.fn(() => Promise.resolve(jsonResponse({}, 429)));
    const provider = new OpenAIConceptExtractionProvider(
      'key',
      OPENAI_CONCEPT_MODEL,
      fetchFn,
      noSleep
    );
    await expect(provider.extract(chunks)).rejects.toThrow(
      'extraction request failed with status 429'
    );
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('throws when the provider returns no message content', async () => {
    const provider = new OpenAIConceptExtractionProvider(
      'key',
      OPENAI_CONCEPT_MODEL,
      () => Promise.resolve(jsonResponse({ choices: [] })),
      noSleep
    );
    await expect(provider.extract(chunks)).rejects.toThrow(ConceptExtractionFailedError);
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

    it('emits one privacy-safe CONCEPT_EXTRACTION event per call, carrying no chunk/prompt content', async () => {
      const provider = new OpenAIConceptExtractionProvider(
        'key',
        OPENAI_CONCEPT_MODEL,
        () => Promise.resolve(chatResponse(validExtraction)),
        noSleep
      );
      await provider.extract(chunks);

      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event).toMatchObject({
        task: 'CONCEPT_EXTRACTION',
        tier: 'ECONOMY',
        provider: 'openai',
        model: OPENAI_CONCEPT_MODEL,
        success: true,
      });
      expect(typeof event!.latencyMs).toBe('number');
      // No field on the event can carry the chunk text or the model's output.
      expect(JSON.stringify(event)).not.toMatch(/Hyperkalemia/);
    });

    it('emits a failure event (without leaking the raw provider error into the event itself) when extraction fails', async () => {
      const provider = new OpenAIConceptExtractionProvider(
        'key',
        OPENAI_CONCEPT_MODEL,
        () => Promise.resolve(jsonResponse({}, 401)),
        noSleep
      );
      await expect(provider.extract(chunks)).rejects.toThrow(ConceptExtractionFailedError);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ task: 'CONCEPT_EXTRACTION', success: false, failureReason: '401' });
    });
  });
});

describe('ScriptedConceptExtractionProvider', () => {
  it('matches its lexicon deterministically against the eval chunks', async () => {
    const provider = new ScriptedConceptExtractionProvider();
    const first = await provider.extract(EVAL_EXTRACTION_CHUNKS);
    const second = await provider.extract(EVAL_EXTRACTION_CHUNKS);
    expect(second).toEqual(first);
    const names = first.concepts.map((concept) => concept.name);
    expect(names).toContain('Diabetic Ketoacidosis');
    expect(names).toContain('Furosemide');
    expect(names).not.toContain('Pulmonary Embolism');
    const dka = first.concepts.find((concept) => concept.name === 'Diabetic Ketoacidosis')!;
    expect(dka.chunk_indexes).toEqual([0]);
  });

  it('identifies itself as scripted so it can never masquerade as a model', () => {
    expect(new ScriptedConceptExtractionProvider().metadata().provider).toBe('scripted');
  });
});

describe('createConceptExtractionProviderFromEnv', () => {
  it('defaults to openai and requires an API key', () => {
    expect(() => createConceptExtractionProviderFromEnv({})).toThrow('OPENAI_API_KEY');
    const provider = createConceptExtractionProviderFromEnv({ OPENAI_API_KEY: 'k' });
    expect(provider.metadata().provider).toBe('openai');
    expect(provider.metadata().model).toBe(OPENAI_CONCEPT_MODEL);
  });

  it('honors CONCEPT_MODEL overrides', () => {
    const provider = createConceptExtractionProviderFromEnv({
      OPENAI_API_KEY: 'k',
      CONCEPT_MODEL: 'gpt-4o',
    });
    expect(provider.metadata().model).toBe('gpt-4o');
  });

  it('supports the scripted development provider', () => {
    const provider = createConceptExtractionProviderFromEnv({ CONCEPT_PROVIDER: 'scripted' });
    expect(provider.metadata().provider).toBe('scripted');
  });

  it('rejects unknown providers', () => {
    expect(() => createConceptExtractionProviderFromEnv({ CONCEPT_PROVIDER: 'oracle' })).toThrow(
      'Unknown CONCEPT_PROVIDER'
    );
  });
});
