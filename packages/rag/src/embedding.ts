import { EmbeddingMetadata, EmbeddingProvider } from './types';

/**
 * Embedding providers (spec B/C, ADR-0012).
 *
 * The production provider is OpenAI `text-embedding-3-small` (1536 dims):
 * strong retrieval quality on clinical/education text, native batching, low
 * cost, and a stable API — called with plain `fetch`, no vendor SDK, so no
 * provider types leak into domain code (Playbook §16).
 *
 * `HashingEmbeddingProvider` is a deterministic, dependency-free bag-of-words
 * embedding used for tests, the retrieval-quality eval set, and keyless local
 * development. It is NOT a semantic model and must never be configured in
 * production; its vectors live in the same 1536-dim space so the whole
 * pipeline (including pgvector storage) can be exercised without a key.
 */

/** Bump when provider, model, or chunking changes require re-embedding. */
export const EMBEDDING_VERSION = 'v1';
export const EMBEDDING_DIMENSION = 1536;

export class EmbeddingFailedError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'EmbeddingFailedError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const OPENAI_URL = 'https://api.openai.com/v1/embeddings';
const OPENAI_MODEL = 'text-embedding-3-small';
/** OpenAI accepts up to 2048 inputs per call; stay conservative. */
const OPENAI_BATCH_SIZE = 100;
const MAX_ATTEMPTS = 3;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchLike = (input, init) => fetch(input, init),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  metadata(): EmbeddingMetadata {
    return {
      provider: 'openai',
      model: OPENAI_MODEL,
      dimension: EMBEDDING_DIMENSION,
      version: EMBEDDING_VERSION,
    };
  }

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += OPENAI_BATCH_SIZE) {
      const batch = texts.slice(start, start + OPENAI_BATCH_SIZE);
      vectors.push(...(await this.embedBatch(batch)));
    }
    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    return vector!;
  }

  /** One API call with bounded retry on rate limits and server errors. */
  private async embedBatch(batch: readonly string[]): Promise<number[][]> {
    if (batch.length === 0) {
      return [];
    }
    let lastError: EmbeddingFailedError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchFn(OPENAI_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: OPENAI_MODEL, input: batch }),
        });
      } catch (error) {
        lastError = new EmbeddingFailedError(
          `network error: ${error instanceof Error ? error.message : String(error)}`
        );
        await this.sleep(500 * attempt);
        continue;
      }
      if (response.ok) {
        const payload = (await response.json()) as {
          data: { index: number; embedding: number[] }[];
        };
        const vectors = [...payload.data]
          .sort((a, z) => a.index - z.index)
          .map((item) => item.embedding);
        if (vectors.length !== batch.length) {
          throw new EmbeddingFailedError(
            `provider returned ${vectors.length} vectors for ${batch.length} inputs`
          );
        }
        for (const vector of vectors) {
          if (vector.length !== EMBEDDING_DIMENSION) {
            throw new EmbeddingFailedError(
              `provider returned dimension ${vector.length}, expected ${EMBEDDING_DIMENSION}`
            );
          }
        }
        return vectors;
      }
      lastError = new EmbeddingFailedError(
        `embedding request failed with status ${response.status}`,
        response.status
      );
      if (response.status === 429 || response.status >= 500) {
        await this.sleep(500 * attempt);
        continue; // transient: retry with backoff
      }
      throw lastError; // 4xx other than 429 will not improve on retry
    }
    throw lastError ?? new EmbeddingFailedError('embedding failed');
  }
}

/** FNV-1a 32-bit hash — stable across platforms and runs. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class HashingEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly dimension: number = EMBEDDING_DIMENSION) {}

  metadata(): EmbeddingMetadata {
    return {
      provider: 'hashing',
      model: `hashing-bow-${this.dimension}`,
      dimension: this.dimension,
      version: EMBEDDING_VERSION,
    };
  }

  embedDocuments(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.embed(text)));
  }

  embedQuery(text: string): Promise<number[]> {
    return Promise.resolve(this.embed(text));
  }

  /** L2-normalized hashed term-frequency vector: cosine ≈ lexical overlap. */
  private embed(text: string): number[] {
    const vector = new Array<number>(this.dimension).fill(0);
    const terms = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const term of terms) {
      vector[fnv1a(term) % this.dimension]! += 1;
    }
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return norm === 0 ? vector : vector.map((v) => v / norm);
  }
}

/**
 * Provider selection from server-side environment (Playbook §5 env contract:
 * EMBEDDING_PROVIDER + OPENAI_API_KEY, backend-only).
 */
export function createEmbeddingProviderFromEnv(
  env: Record<string, string | undefined>
): EmbeddingProvider {
  const provider = env.EMBEDDING_PROVIDER ?? 'openai';
  if (provider === 'openai') {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY.');
    }
    return new OpenAIEmbeddingProvider(apiKey);
  }
  if (provider === 'hashing') {
    // Deterministic keyless embedding for development only.
    return new HashingEmbeddingProvider();
  }
  throw new Error(`Unknown EMBEDDING_PROVIDER "${provider}".`);
}
