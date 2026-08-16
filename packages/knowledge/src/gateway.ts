import { CONCEPT_RELATIONSHIP_TYPES, CONCEPT_TYPES } from '@avidia/domain';
import { emitAiRouterEvent, routeAiTask } from '@avidia/ai-router';

import { ExtractionChunk, RawExtraction, extractionJsonSchema, validateExtraction } from './schema';

/**
 * Provider-independent concept-extraction gateway (M6 spec D/E/T; Playbook
 * §16 and Blueprint "AI gateway": provider-agnostic routing, no vendor SDK,
 * no provider types past this seam, keys server-side only — screens never
 * call a provider).
 *
 * The production provider is OpenAI, at the ECONOMY tier resolved from
 * `@avidia/ai-router` (AI model routing v1, spec section 3/5: task ->
 * CONCEPT_EXTRACTION -> ECONOMY — high volume, structured, validated
 * downstream; "do not let screens/packages hard-code model names"), called
 * with plain `fetch` and constrained JSON output. The literal model id lives
 * in exactly one place, `@avidia/ai-router`'s `openai.ts` — this file only
 * ever asks for `OPENAI_CHAT_MODELS.ECONOMY`. `ScriptedConceptExtractionProvider`
 * is the deterministic keyless seam used by tests, the quality evaluation,
 * and local development — it is NOT a language model and must never be
 * configured in production.
 */

/** Bump when the extraction pipeline changes in a way that requires re-runs. */
export const CONCEPT_EXTRACTION_VERSION = 'v1';
/** Bump when the prompt text changes (spec E prompt versioning). */
export const CONCEPT_PROMPT_VERSION = 'p1';

export interface ConceptExtractionMetadata {
  provider: string;
  model: string;
  promptVersion: string;
  extractionVersion: string;
}

export interface ConceptExtractionProvider {
  /** Extract schema-valid raw candidates from one batch of chunks. */
  extract(chunks: readonly ExtractionChunk[]): Promise<RawExtraction>;
  metadata(): ConceptExtractionMetadata;
}

export class ConceptExtractionFailedError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'ConceptExtractionFailedError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
/**
 * Resolved from the AI router's ECONOMY tier (CONCEPT_EXTRACTION's fixed
 * tier — see packages/ai-router/src/tiers.ts), not hard-coded here. The
 * CONCEPT_MODEL env var (read in createConceptExtractionProviderFromEnv
 * below) still overrides this default, preserving the pre-router env
 * contract (spec section 7).
 */
export const OPENAI_CONCEPT_MODEL = routeAiTask({
  task: 'CONCEPT_EXTRACTION',
  complexity: 'MEDIUM',
}).model;
const MAX_ATTEMPTS = 3;

/**
 * The system prompt (version CONCEPT_PROMPT_VERSION). Grounding rules
 * (spec D/K): only concepts actually taught by the supplied excerpts, cited
 * by chunk index — never general medical knowledge presented as course
 * content.
 */
export const CONCEPT_EXTRACTION_SYSTEM_PROMPT = [
  "You extract nursing-education concepts from excerpts of a student's own course material.",
  'Identify only educationally meaningful concepts a nursing student must reason about:',
  'diseases/disorders, pathophysiology, signs/symptoms, assessments, labs, diagnostics,',
  'medications, interventions, priorities, complications, risk factors, procedures,',
  'safety issues, patient education, anatomy/physiology, and calculations.',
  'Never output generic standalone words such as "patient", "blood", "hospital", or "body".',
  "Use the material's own terminology for canonical names; list common abbreviations",
  '(e.g. DKA, COPD) as aliases of the full name rather than separate concepts.',
  'Cite, for every concept and relationship, the 0-based indexes of the supporting',
  'excerpts. Only claim what the excerpts actually teach; do not add outside knowledge.',
  'Propose relationships only when the material itself supports them.',
].join(' ');

export class OpenAIConceptExtractionProvider implements ConceptExtractionProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = OPENAI_CONCEPT_MODEL,
    private readonly fetchFn: FetchLike = (input, init) => fetch(input, init),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  metadata(): ConceptExtractionMetadata {
    return {
      provider: 'openai',
      model: this.model,
      promptVersion: CONCEPT_PROMPT_VERSION,
      extractionVersion: CONCEPT_EXTRACTION_VERSION,
    };
  }

  async extract(chunks: readonly ExtractionChunk[]): Promise<RawExtraction> {
    if (chunks.length === 0) {
      return { concepts: [], relationships: [] };
    }
    const startedAt = Date.now();
    try {
      const value = await this.extractViaChat(chunks);
      emitAiRouterEvent({
        task: 'CONCEPT_EXTRACTION',
        complexity: 'MEDIUM',
        tier: 'ECONOMY',
        provider: 'openai',
        model: this.model,
        latencyMs: Date.now() - startedAt,
        retryCount: 0,
        usedFallback: false,
        success: true,
      });
      return value;
    } catch (error) {
      emitAiRouterEvent({
        task: 'CONCEPT_EXTRACTION',
        complexity: 'MEDIUM',
        tier: 'ECONOMY',
        provider: 'openai',
        model: this.model,
        latencyMs: Date.now() - startedAt,
        retryCount: 0,
        usedFallback: false,
        success: false,
        failureReason:
          error instanceof ConceptExtractionFailedError ? String(error.status ?? 'other') : 'other',
      });
      throw error;
    }
  }

  /**
   * Observability wraps this whole extract-then-optionally-repair round as
   * one task-level event (spec section 8) — the per-HTTP-attempt retry loop
   * inside `complete()` stays local to this provider for now (v1 scope; see
   * docs/AI_MODEL_ROUTING.md for why full per-attempt fallback escalation via
   * `executeAiTask` is deferred for this call site).
   */
  private async extractViaChat(chunks: readonly ExtractionChunk[]): Promise<RawExtraction> {
    const userPrompt = chunks
      .map((chunk, index) => `[${index}] (${chunk.locator})\n${chunk.content}`)
      .join('\n\n');

    const raw = await this.complete([
      { role: 'system', content: CONCEPT_EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ]);
    const first = validateExtraction(raw, chunks.length);
    if (first.ok) {
      return first.value;
    }
    // Controlled repair (spec E): one follow-up naming the exact violations.
    const repaired = await this.complete([
      { role: 'system', content: CONCEPT_EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: JSON.stringify(raw) },
      {
        role: 'user',
        content:
          'Your previous response violated the required schema: ' +
          first.errors.slice(0, 10).join('; ') +
          '. Return the corrected JSON only.',
      },
    ]);
    const second = validateExtraction(repaired, chunks.length);
    if (!second.ok) {
      throw new ConceptExtractionFailedError(
        `structured output invalid after repair: ${second.errors.slice(0, 5).join('; ')}`
      );
    }
    return second.value;
  }

  /** One chat call with constrained JSON output and bounded retry. */
  private async complete(messages: { role: string; content: string }[]): Promise<unknown> {
    let lastError: ConceptExtractionFailedError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchFn(OPENAI_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            temperature: 0,
            messages,
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'concept_extraction',
                strict: true,
                schema: extractionJsonSchema(CONCEPT_TYPES, CONCEPT_RELATIONSHIP_TYPES),
              },
            },
          }),
        });
      } catch (error) {
        lastError = new ConceptExtractionFailedError(
          `network error: ${error instanceof Error ? error.message : String(error)}`
        );
        await this.sleep(500 * attempt);
        continue;
      }
      if (response.ok) {
        const payload = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new ConceptExtractionFailedError('provider returned no message content');
        }
        try {
          return JSON.parse(content) as unknown;
        } catch {
          // Not JSON at all — surface as an invalid structure so the caller's
          // repair round can run (it re-validates whatever we return).
          return content;
        }
      }
      lastError = new ConceptExtractionFailedError(
        `extraction request failed with status ${response.status}`,
        response.status
      );
      if (response.status === 429 || response.status >= 500) {
        await this.sleep(500 * attempt);
        continue; // transient: retry with backoff
      }
      throw lastError; // other 4xx will not improve on retry
    }
    throw lastError ?? new ConceptExtractionFailedError('extraction failed');
  }
}

/**
 * Deterministic keyless extractor for tests, evaluation, and local dev: a
 * fixed nursing lexicon matched against chunk text. Cheap, repeatable, and
 * honest about what it is — never configure in production.
 */
export class ScriptedConceptExtractionProvider implements ConceptExtractionProvider {
  constructor(
    private readonly lexicon: {
      name: string;
      type: string;
      aliases?: string[];
      summary?: string;
    }[] = DEFAULT_SCRIPTED_LEXICON
  ) {}

  metadata(): ConceptExtractionMetadata {
    return {
      provider: 'scripted',
      model: 'scripted-lexicon',
      promptVersion: CONCEPT_PROMPT_VERSION,
      extractionVersion: CONCEPT_EXTRACTION_VERSION,
    };
  }

  extract(chunks: readonly ExtractionChunk[]): Promise<RawExtraction> {
    const concepts = this.lexicon
      .map((entry) => {
        // Whole-word matching: the alias "PE" must not match inside "peaked".
        const needles = [entry.name, ...(entry.aliases ?? [])].map(
          (needle) => new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
        );
        const chunk_indexes = chunks
          .map((chunk, index) => ({ chunk, index }))
          .filter(({ chunk }) => needles.some((needle) => needle.test(chunk.content)))
          .map(({ index }) => index);
        return {
          name: entry.name,
          type: entry.type,
          summary: entry.summary,
          aliases: entry.aliases ?? [],
          chunk_indexes,
        };
      })
      .filter((concept) => concept.chunk_indexes.length > 0);
    return Promise.resolve({ concepts, relationships: [] });
  }
}

/** Small high-signal lexicon for keyless local development. */
export const DEFAULT_SCRIPTED_LEXICON = [
  { name: 'Diabetic Ketoacidosis', type: 'disease_disorder', aliases: ['DKA'] },
  { name: 'Hyperkalemia', type: 'laboratory' },
  { name: 'Hypokalemia', type: 'laboratory' },
  { name: 'Heart Failure', type: 'disease_disorder', aliases: ['HF'] },
  { name: 'Pulmonary Embolism', type: 'disease_disorder', aliases: ['PE'] },
  {
    name: 'Chronic Obstructive Pulmonary Disease',
    type: 'disease_disorder',
    aliases: ['COPD'],
  },
  { name: 'Furosemide', type: 'medication', aliases: ['Lasix'] },
  { name: 'Metabolic Acidosis', type: 'laboratory' },
  { name: 'Kussmaul Respirations', type: 'sign_symptom' },
];

/**
 * Provider selection from server-side environment (spec D; env contract:
 * CONCEPT_PROVIDER + OPENAI_API_KEY + optional CONCEPT_MODEL, backend-only).
 */
export function createConceptExtractionProviderFromEnv(
  env: Record<string, string | undefined>
): ConceptExtractionProvider {
  const provider = env.CONCEPT_PROVIDER ?? 'openai';
  if (provider === 'openai') {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('CONCEPT_PROVIDER=openai requires OPENAI_API_KEY.');
    }
    const route = routeAiTask({ task: 'CONCEPT_EXTRACTION', complexity: 'MEDIUM' }, env);
    return new OpenAIConceptExtractionProvider(apiKey, env.CONCEPT_MODEL ?? route.model);
  }
  if (provider === 'scripted') {
    // Deterministic keyless extraction for development only.
    return new ScriptedConceptExtractionProvider();
  }
  throw new Error(`Unknown CONCEPT_PROVIDER "${provider}".`);
}
