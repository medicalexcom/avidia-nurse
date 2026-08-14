import {
  COGNITIVE_LEVELS,
  PRIORITY_FRAMEWORKS,
  QUESTION_DIFFICULTIES,
  QUESTION_TYPES,
} from '@avidia/domain';

import {
  GenerationChunk,
  GenerationConcept,
  RawGeneratedQuestion,
  RawGeneration,
  generationJsonSchema,
  validateGeneration,
} from './schema';

/**
 * Provider-independent question-generation gateway (M7 spec G/I/AE; Playbook
 * §16 and Blueprint "AI gateway": provider-agnostic routing, no vendor SDK,
 * no provider types past this seam, keys server-side only — screens never
 * call a provider).
 *
 * The production provider is OpenAI `gpt-4o-mini` (Playbook §16 routes
 * question generation to the low-cost model: high volume, structured,
 * validated downstream) called with plain `fetch` and constrained JSON
 * output. `ScriptedQuestionGenerationProvider` is the deterministic keyless
 * seam used by tests, the quality evaluation, and local development — it is
 * NOT a language model and must never be configured in production.
 */

/** Bump when the generation pipeline changes in a way that requires re-runs. */
export const QUESTION_GENERATION_VERSION = 'v1';
/** Bump when the prompt text changes (spec AD prompt versioning). */
export const QUESTION_PROMPT_VERSION = 'p1';

export interface QuestionGenerationMetadata {
  provider: string;
  model: string;
  promptVersion: string;
  generationVersion: string;
}

export interface QuestionGenerationProvider {
  /** Generate schema-valid raw questions for concepts grounded in chunks. */
  generate(
    concepts: readonly GenerationConcept[],
    chunks: readonly GenerationChunk[]
  ): Promise<RawGeneration>;
  metadata(): QuestionGenerationMetadata;
}

export class QuestionGenerationFailedError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'QuestionGenerationFailedError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
export const OPENAI_QUESTION_MODEL = 'gpt-4o-mini';
const MAX_ATTEMPTS = 3;

/**
 * The system prompt (version QUESTION_PROMPT_VERSION). Encodes the item
 * craft rules the validation pipeline then enforces independently: clinical
 * reasoning over vocabulary (spec D), grounding in the supplied excerpts
 * only (spec G), teaching rationales (spec M), plausible distractors without
 * giveaways (spec N), and deterministic math as data (spec P).
 */
export const QUESTION_GENERATION_SYSTEM_PROMPT = [
  'You write NCLEX-style practice questions for a nursing student, grounded ONLY in',
  "the supplied excerpts of the student's own course material.",
  'Write clinical reasoning questions, not vocabulary checks: put the client in a',
  'situation (vitals, labs, medications, symptoms) and ask what the nurse should',
  'do, assess, or prioritize. Never ask "what is <term>?".',
  'Cite, for every question, the 0-based indexes of the supporting excerpts; only',
  'claim what the excerpts actually teach. If the excerpts do not support a',
  'question, do not write it.',
  'Every question needs a rationale that teaches: why the correct answer is',
  'correct, and per-option rationales for why each distractor is wrong.',
  'Distractors must be plausible and clinically related; avoid "always", "never",',
  '"all of the above", and do not make the correct option the longest one.',
  'single_best_answer has exactly one correct option. multiple_response has two or',
  'more correct options by design. ordered_response options carry',
  'correct_position 1..n. numeric_calculation has NO options: provide the exact',
  'expected_value, a tolerance, the unit, and a rounding note; double-check the',
  'arithmetic. Set fields that do not apply to null.',
  'Vary difficulty (easy/moderate/hard) and cognitive level; tag nursing priority',
  'frameworks (abc, safety, ...) when the question involves prioritization.',
].join(' ');

export class OpenAIQuestionGenerationProvider implements QuestionGenerationProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = OPENAI_QUESTION_MODEL,
    private readonly fetchFn: FetchLike = (input, init) => fetch(input, init),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  metadata(): QuestionGenerationMetadata {
    return {
      provider: 'openai',
      model: this.model,
      promptVersion: QUESTION_PROMPT_VERSION,
      generationVersion: QUESTION_GENERATION_VERSION,
    };
  }

  async generate(
    concepts: readonly GenerationConcept[],
    chunks: readonly GenerationChunk[]
  ): Promise<RawGeneration> {
    if (concepts.length === 0 || chunks.length === 0) {
      return { questions: [] };
    }
    const conceptList = concepts
      .map((concept) => `- ${concept.name} (key: ${concept.key}, type: ${concept.type})`)
      .join('\n');
    const excerpts = chunks
      .map((chunk, index) => `[${index}] (${chunk.locator})\n${chunk.content}`)
      .join('\n\n');
    const userPrompt =
      `Concepts to cover (use the given key as concept_key):\n${conceptList}\n\n` +
      `Course material excerpts:\n${excerpts}\n\n` +
      `Write 1-2 questions per concept, mixing question types, difficulties and cognitive levels.`;

    const raw = await this.complete([
      { role: 'system', content: QUESTION_GENERATION_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ]);
    const first = validateGeneration(raw, chunks.length);
    if (first.ok) {
      return first.value;
    }
    // Controlled repair (spec J): one follow-up naming the exact violations.
    const repaired = await this.complete([
      { role: 'system', content: QUESTION_GENERATION_SYSTEM_PROMPT },
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
    const second = validateGeneration(repaired, chunks.length);
    if (!second.ok) {
      throw new QuestionGenerationFailedError(
        `structured output invalid after repair: ${second.errors.slice(0, 5).join('; ')}`
      );
    }
    return second.value;
  }

  /** One chat call with constrained JSON output and bounded retry. */
  private async complete(messages: { role: string; content: string }[]): Promise<unknown> {
    let lastError: QuestionGenerationFailedError | null = null;
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
                name: 'question_generation',
                strict: true,
                schema: generationJsonSchema(
                  QUESTION_TYPES,
                  QUESTION_DIFFICULTIES,
                  COGNITIVE_LEVELS,
                  PRIORITY_FRAMEWORKS
                ),
              },
            },
          }),
        });
      } catch (error) {
        lastError = new QuestionGenerationFailedError(
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
          throw new QuestionGenerationFailedError('provider returned no message content');
        }
        try {
          return JSON.parse(content) as unknown;
        } catch {
          // Not JSON at all — surface as an invalid structure so the caller's
          // repair round can run (it re-validates whatever we return).
          return content;
        }
      }
      lastError = new QuestionGenerationFailedError(
        `generation request failed with status ${response.status}`,
        response.status
      );
      if (response.status === 429 || response.status >= 500) {
        await this.sleep(500 * attempt);
        continue; // transient: retry with backoff
      }
      throw lastError; // other 4xx will not improve on retry
    }
    throw lastError ?? new QuestionGenerationFailedError('generation failed');
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deterministic keyless generator for tests, evaluation, and local dev:
 * fixed clinical templates instantiated for each supplied concept that
 * actually appears in the chunk text. Cheap, repeatable, and honest about
 * what it is — never configure in production.
 */
export class ScriptedQuestionGenerationProvider implements QuestionGenerationProvider {
  metadata(): QuestionGenerationMetadata {
    return {
      provider: 'scripted',
      model: 'scripted-templates',
      promptVersion: QUESTION_PROMPT_VERSION,
      generationVersion: QUESTION_GENERATION_VERSION,
    };
  }

  generate(
    concepts: readonly GenerationConcept[],
    chunks: readonly GenerationChunk[]
  ): Promise<RawGeneration> {
    const questions: RawGeneratedQuestion[] = [];
    for (const concept of concepts) {
      // Whole-word matching against chunk text: cite only real evidence.
      const needle = new RegExp(`\\b${escapeRegExp(concept.name)}\\b`, 'i');
      const chunkIndexes = chunks
        .map((chunk, index) => ({ chunk, index }))
        .filter(({ chunk }) => needle.test(chunk.content))
        .map(({ index }) => index);
      if (chunkIndexes.length === 0) {
        continue;
      }
      questions.push({
        question_type: 'single_best_answer',
        stem:
          `The nurse is caring for a client whose assessment findings are consistent with ` +
          `${concept.name}. After reviewing the orders, which action should the nurse take first?`,
        difficulty: 'moderate',
        cognitive_level: 'application',
        concept_key: concept.key,
        priority_frameworks: ['safety'],
        rationale:
          `Verifying the client's current status directs every subsequent intervention for ` +
          `${concept.name}; acting on stale data risks treating the wrong problem.`,
        options: [
          {
            text: 'Complete a focused reassessment and compare against baseline findings',
            is_correct: true,
            correct_position: null,
            rationale: 'Current data must drive the intervention that follows.',
          },
          {
            text: 'Document the findings and continue the plan of care unchanged',
            is_correct: false,
            correct_position: null,
            rationale: 'Continuing unchanged ignores a potentially evolving condition.',
          },
          {
            text: 'Ask the family to observe the client and report any changes later',
            is_correct: false,
            correct_position: null,
            rationale: 'Assessment is a nursing responsibility that cannot be delegated to family.',
          },
          {
            text: 'Prepare discharge teaching materials for the client',
            is_correct: false,
            correct_position: null,
            rationale: 'Teaching is premature while the acute finding is unevaluated.',
          },
        ],
        expected_value: null,
        tolerance: null,
        answer_unit: null,
        rounding_note: null,
        chunk_indexes: chunkIndexes,
      });
      if (concept.type === 'medication') {
        questions.push({
          question_type: 'numeric_calculation',
          stem:
            `The provider prescribes ${concept.name} 40 mg by mouth daily. The pharmacy ` +
            `supplies 20 mg tablets. How many tablets should the nurse administer per dose?`,
          difficulty: 'easy',
          cognitive_level: 'application',
          concept_key: concept.key,
          priority_frameworks: [],
          rationale:
            'Dose ordered (40 mg) divided by dose on hand (20 mg per tablet) equals 2 tablets.',
          options: [],
          expected_value: 2,
          tolerance: 0,
          answer_unit: 'tablets',
          rounding_note: 'Answer with a whole number of tablets.',
          chunk_indexes: chunkIndexes,
        });
      }
    }
    return Promise.resolve({ questions });
  }
}

/**
 * Provider selection from server-side environment (spec I; env contract:
 * QUESTION_PROVIDER + OPENAI_API_KEY + optional QUESTION_MODEL, backend-only).
 */
export function createQuestionGenerationProviderFromEnv(
  env: Record<string, string | undefined>
): QuestionGenerationProvider {
  const provider = env.QUESTION_PROVIDER ?? 'openai';
  if (provider === 'openai') {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('QUESTION_PROVIDER=openai requires OPENAI_API_KEY.');
    }
    return new OpenAIQuestionGenerationProvider(
      apiKey,
      env.QUESTION_MODEL ?? OPENAI_QUESTION_MODEL
    );
  }
  if (provider === 'scripted') {
    // Deterministic keyless generation for development only.
    return new ScriptedQuestionGenerationProvider();
  }
  throw new Error(`Unknown QUESTION_PROVIDER "${provider}".`);
}
