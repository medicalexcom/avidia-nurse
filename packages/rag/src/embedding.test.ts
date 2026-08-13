import {
  EMBEDDING_DIMENSION,
  EMBEDDING_VERSION,
  EmbeddingFailedError,
  HashingEmbeddingProvider,
  OpenAIEmbeddingProvider,
  createEmbeddingProviderFromEnv,
} from './embedding';

function okResponse(vectors: number[][]): Response {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        data: vectors.map((embedding, index) => ({ index, embedding })),
      }),
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return { ok: false, status, json: () => Promise.resolve({}) } as unknown as Response;
}

const noSleep = () => Promise.resolve();

describe('HashingEmbeddingProvider', () => {
  const provider = new HashingEmbeddingProvider();

  it('produces 1536-dim, L2-normalized, deterministic vectors', async () => {
    const [a] = await provider.embedDocuments(['furosemide is a loop diuretic']);
    const b = await provider.embedQuery('furosemide is a loop diuretic');
    expect(a).toHaveLength(EMBEDDING_DIMENSION);
    expect(a).toEqual(b);
    const norm = Math.sqrt(a!.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('scores lexically-overlapping texts higher than unrelated texts', async () => {
    const query = await provider.embedQuery('furosemide potassium monitoring');
    const [related, unrelated] = await provider.embedDocuments([
      'furosemide requires potassium monitoring for hypokalemia',
      'the museum opens on tuesday afternoons',
    ]);
    const dot = (x: number[], y: number[]) => x.reduce((sum, v, i) => sum + v * y[i]!, 0);
    expect(dot(query, related!)).toBeGreaterThan(dot(query, unrelated!));
  });

  it('returns a zero vector for text with no terms', async () => {
    const vector = await provider.embedQuery('!!!');
    expect(vector.every((v) => v === 0)).toBe(true);
  });

  it('reports metadata', () => {
    expect(provider.metadata()).toEqual({
      provider: 'hashing',
      model: `hashing-bow-${EMBEDDING_DIMENSION}`,
      dimension: EMBEDDING_DIMENSION,
      version: EMBEDDING_VERSION,
    });
  });
});

describe('OpenAIEmbeddingProvider', () => {
  const vector = () => new Array(EMBEDDING_DIMENSION).fill(0.1);

  it('reports openai metadata', () => {
    const provider = new OpenAIEmbeddingProvider('key');
    expect(provider.metadata()).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimension: EMBEDDING_DIMENSION,
      version: EMBEDDING_VERSION,
    });
  });

  it('embeds documents in batches of 100, preserving order', async () => {
    const calls: string[][] = [];
    const fetchFn = jest.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      calls.push(body.input);
      // Return vectors out of order to verify index-based sorting.
      const data = body.input.map((_, index) => ({ index, embedding: vector() }));
      data.reverse();
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data }),
      } as unknown as Response);
    });
    const provider = new OpenAIEmbeddingProvider('key', fetchFn, noSleep);
    const texts = Array.from({ length: 150 }, (_, i) => `text ${i}`);
    const vectors = await provider.embedDocuments(texts);
    expect(vectors).toHaveLength(150);
    expect(calls.map((c) => c.length)).toEqual([100, 50]);
    expect(calls[0]![0]).toBe('text 0');
    expect(calls[1]![49]).toBe('text 149');
  });

  it('sends the API key and model in the request', async () => {
    const fetchFn = jest.fn((_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer secret-key');
      const body = JSON.parse(String(init?.body)) as { model: string };
      expect(body.model).toBe('text-embedding-3-small');
      return Promise.resolve(okResponse([vector()]));
    });
    const provider = new OpenAIEmbeddingProvider('secret-key', fetchFn, noSleep);
    await provider.embedQuery('hello');
    expect(fetchFn).toHaveBeenCalledWith('https://api.openai.com/v1/embeddings', expect.anything());
  });

  it('retries 429 and 5xx with backoff, then succeeds', async () => {
    const responses = [errorResponse(429), errorResponse(503), okResponse([vector()])];
    const fetchFn = jest.fn(() => Promise.resolve(responses.shift()!));
    const sleep = jest.fn(noSleep);
    const provider = new OpenAIEmbeddingProvider('key', fetchFn, sleep);
    const result = await provider.embedQuery('retry me');
    expect(result).toHaveLength(EMBEDDING_DIMENSION);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after three attempts on persistent 429', async () => {
    const fetchFn = jest.fn(() => Promise.resolve(errorResponse(429)));
    const provider = new OpenAIEmbeddingProvider('key', fetchFn, noSleep);
    await expect(provider.embedQuery('never')).rejects.toThrow(EmbeddingFailedError);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('fails immediately on non-retryable 4xx', async () => {
    const fetchFn = jest.fn(() => Promise.resolve(errorResponse(401)));
    const provider = new OpenAIEmbeddingProvider('bad-key', fetchFn, noSleep);
    await expect(provider.embedQuery('denied')).rejects.toThrow('status 401');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries network errors', async () => {
    let first = true;
    const fetchFn = jest.fn(() => {
      if (first) {
        first = false;
        return Promise.reject(new Error('socket hang up'));
      }
      return Promise.resolve(okResponse([vector()]));
    });
    const provider = new OpenAIEmbeddingProvider('key', fetchFn, noSleep);
    await expect(provider.embedQuery('flaky')).resolves.toHaveLength(EMBEDDING_DIMENSION);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('rejects a response with the wrong vector count', async () => {
    const fetchFn = jest.fn(() => Promise.resolve(okResponse([])));
    const provider = new OpenAIEmbeddingProvider('key', fetchFn, noSleep);
    await expect(provider.embedQuery('missing')).rejects.toThrow('0 vectors for 1 inputs');
  });

  it('rejects a response with the wrong dimension', async () => {
    const fetchFn = jest.fn(() => Promise.resolve(okResponse([[1, 2, 3]])));
    const provider = new OpenAIEmbeddingProvider('key', fetchFn, noSleep);
    await expect(provider.embedQuery('short')).rejects.toThrow('dimension 3');
  });

  it('returns no vectors for an empty document list without calling the API', async () => {
    const fetchFn = jest.fn();
    const provider = new OpenAIEmbeddingProvider('key', fetchFn, noSleep);
    await expect(provider.embedDocuments([])).resolves.toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('createEmbeddingProviderFromEnv', () => {
  it('defaults to openai and requires an API key', () => {
    expect(() => createEmbeddingProviderFromEnv({})).toThrow('OPENAI_API_KEY');
    const provider = createEmbeddingProviderFromEnv({ OPENAI_API_KEY: 'k' });
    expect(provider.metadata().provider).toBe('openai');
  });

  it('selects the hashing provider for keyless development', () => {
    const provider = createEmbeddingProviderFromEnv({ EMBEDDING_PROVIDER: 'hashing' });
    expect(provider.metadata().provider).toBe('hashing');
  });

  it('rejects unknown providers', () => {
    expect(() => createEmbeddingProviderFromEnv({ EMBEDDING_PROVIDER: 'mystery' })).toThrow(
      'Unknown EMBEDDING_PROVIDER'
    );
  });
});
