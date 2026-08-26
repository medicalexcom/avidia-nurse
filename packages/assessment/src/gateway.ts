import {
  COGNITIVE_LEVELS,
  PRIORITY_FRAMEWORKS,
  QUESTION_DIFFICULTIES,
  QUESTION_TYPES,
} from '@avidia/domain';
import { emitAiRouterEvent, routeAiTask } from '@avidia/ai-router';

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
 * The production provider is OpenAI, at the ECONOMY tier resolved from
 * `@avidia/ai-router` (AI model routing v1, spec section 3/5: task ->
 * QUESTION_GENERATION_ROUTINE -> ECONOMY — high volume, structured,
 * validated downstream; "do not let screens/packages hard-code model
 * names"), called with plain `fetch` and constrained JSON output. The
 * literal model id lives in exactly one place, `@avidia/ai-router`'s
 * `openai.ts` — this file only ever asks for `OPENAI_CHAT_MODELS.ECONOMY`.
 * `ScriptedQuestionGenerationProvider` is the deterministic keyless seam
 * used by tests, the quality evaluation, and local development — it is NOT
 * a language model and must never be configured in production.
 *
 * Skill #3: Enhanced with Bloom's Taxonomy cognitive level control for multi-level generation.
 */

/** Bump when the generation pipeline changes in a way that requires re-runs. */
export const QUESTION_GENERATION_VERSION = 'v3';
/** Bump when the prompt text changes (spec AD prompt versioning). */
export const QUESTION_PROMPT_VERSION = 'p3';

export interface QuestionGenerationMetadata {
  provider: string;
  model: string;
  promptVersion: string;
  generationVersion: string;
}

/**
 * Skill #3: Configuration for generating questions at specific Bloom's levels.
 */
export interface BloomsLevelGenerationRequest {
  /** Target cognitive level(s) for this batch. */
  targetLevels: 'all' | 'foundational' | 'intermediate' | 'advanced' | readonly string[];
  /** Whether to generate questions across mixed levels or segregated by level. */
  segregateByLevel?: boolean;
  /** Minimum number of questions per cognitive level (when segregated). */
  minPerLevel?: number;
}

export interface QuestionGenerationProvider {
  /** Generate schema-valid raw questions for concepts grounded in chunks. */
  generate(
    concepts: readonly GenerationConcept[],
    chunks: readonly GenerationChunk[],
    bloomsRequest?: BloomsLevelGenerationRequest
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
/**
 * Resolved from the AI router's ECONOMY tier (QUESTION_GENERATION_ROUTINE's
 * fixed tier — see packages/ai-router/src/tiers.ts), not hard-coded here.
 * The QUESTION_MODEL env var (read in createQuestionGenerationProviderFromEnv
 * below) still overrides this default, preserving the pre-router env
 * contract (spec section 7).
 */
export const OPENAI_QUESTION_MODEL = routeAiTask({
  task: 'QUESTION_GENERATION_ROUTINE',
  complexity: 'MEDIUM',
}).model;
const MAX_ATTEMPTS = 3;

/**
 * The system prompt (version QUESTION_PROMPT_VERSION). Encodes the item
 * craft rules the validation pipeline then enforces independently: clinical
 * reasoning over vocabulary (spec D), grounding in the supplied excerpts
 * only (spec G), teaching rationales (spec M), plausible distractors without
 * giveaways (spec N), and deterministic math as data (spec P).
 *
 * Skill #3: Enhanced with Bloom's Taxonomy instructions for cognitive level control.
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
  '',
  '=== BLOOM\'S TAXONOMY COGNITIVE LEVELS (Skill #3) ===',
  'Map questions to Bloom\'s cognitive levels to build deeper learning:',
  '  - recall (L1): Remember facts, definitions, terminology',
  '    Example: "What is the normal potassium range?" Answer: 3.5-5.0 mEq/L',
  '  - understanding (L2): Explain, summarize, classify, describe concepts',
  '    Example: "Why does hypokalemia cause muscle weakness?" (pathophysiology)',
  '  - application (L3): Apply concepts to new situations, solve problems',
  '    Example: "A client has K+ 2.8. Which intervention is priority?" (clinical decision)',
  '  - analysis (L4): Analyze parts, distinguish relationships, identify causes',
  '    Example: "Compare hypokalemia vs hyperkalemia ECG findings and prioritize."',
  '  - evaluation (L5): Make judgments based on criteria, defend positions',
  '    Example: "Evaluate these lab values and medications: which poses highest risk?"',
  '  - synthesis (L6): Combine elements into new patterns, evaluate alternatives',
  '    Example: "Design a comprehensive monitoring plan for a client on digoxin therapy."',
  '',
  'Progress from recall → understanding → application → analysis → evaluation.',
  'Nursing exams emphasize L3-L5 (clinical reasoning). Start students at L1-L2 to build',
  'foundational knowledge, then progress to L3-L5 for mastery. Never skip levels.',
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
    chunks: readonly GenerationChunk[],
    bloomsRequest?: BloomsLevelGenerationRequest
  ): Promise<RawGeneration> {
    if (concepts.length === 0 || chunks.length === 0) {
      return { questions: [] };
    }
    const startedAt = Date.now();
    try {
      const value = await this.generateViaChat(concepts, chunks, bloomsRequest);
      emitAiRouterEvent({
        task: 'QUESTION_GENERATION_ROUTINE',
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
        task: 'QUESTION_GENERATION_ROUTINE',
        complexity: 'MEDIUM',
        tier: 'ECONOMY',
        provider: 'openai',
        model: this.model,
        latencyMs: Date.now() - startedAt,
        retryCount: 0,
        usedFallback: false,
        success: false,
        failureReason:
          error instanceof QuestionGenerationFailedError
            ? String(error.status ?? 'other')
            : 'other',
      });
      throw error;
    }
  }

  /**
   * Observability wraps this whole generate-then-optionally-repair round as
   * one task-level event (spec section 8) — the per-HTTP-attempt retry loop
   * inside `complete()` stays local to this provider for now (v1 scope; see
   * docs/AI_MODEL_ROUTING.md for why full per-attempt fallback escalation via
   * `executeAiTask` is deferred for this call site).
   */
  private async generateViaChat(
    concepts: readonly GenerationConcept[],
    chunks: readonly GenerationChunk[],
    bloomsRequest?: BloomsLevelGenerationRequest
  ): Promise<RawGeneration> {
    const conceptList = concepts
      .map((concept) => `- ${concept.name} (key: ${concept.key}, type: ${concept.type})`)
      .join('\n');
    const excerpts = chunks
      .map((chunk, index) => `[${index}] (${chunk.locator})\n${chunk.content}`)
      .join('\n\n');

    // Skill #3: Build Bloom's level instruction for the prompt
    let bloomsInstruction = '';
    if (bloomsRequest) {
      if (bloomsRequest.targetLevels === 'all') {
        bloomsInstruction =
          'Mix questions across ALL Bloom\'s cognitive levels (recall, understanding, application, analysis, evaluation, synthesis) ' +
          'to build comprehensive mastery from foundational to deep reasoning.\n';
      } else if (bloomsRequest.targetLevels === 'foundational') {
        bloomsInstruction =
          'Focus on foundational Bloom\'s levels: recall (facts, definitions) and understanding (explanation, summary). ' +
          'Build the knowledge foundation before moving to application.\n';
      } else if (bloomsRequest.targetLevels === 'intermediate') {
        bloomsInstruction =
          'Focus on intermediate Bloom\'s levels: application (solve problems, make clinical decisions) and analysis (distinguish relationships, identify causes). ' +
          'These questions prepare for clinical reasoning on exams.\n';
      } else if (bloomsRequest.targetLevels === 'advanced') {
        bloomsInstruction =
          'Focus on advanced Bloom\'s levels: evaluation (make judgments, defend decisions) and synthesis (combine elements, evaluate alternatives). ' +
          'These are mastery-level questions requiring integration of multiple concepts.\n';
      } else if (Array.isArray(bloomsRequest.targetLevels)) {
        const levels = bloomsRequest.targetLevels.join(', ');
        bloomsInstruction = `Focus on these specific Bloom\'s cognitive levels: ${levels}.\n`;
      }

      if (bloomsRequest.segregateByLevel && bloomsRequest.minPerLevel) {
        bloomsInstruction +=
          `Segregate questions by cognitive level: generate at least ${bloomsRequest.minPerLevel} ` +
          `questions for EACH target level so students can practice progressively.\n`;
      }
    } else {
      bloomsInstruction =
        'Vary cognitive levels across the batch: mix recall, understanding, application, and analysis. ' +
        'Do NOT ask only definition questions; emphasize clinical reasoning (L3-L5).\n';
    }

    const userPrompt =
      `Concepts to cover (use the given key as concept_key):\n${conceptList}\n\n` +
      `Course material excerpts:\n${excerpts}\n\n` +
      bloomsInstruction +
      `Write 2-3 questions for EACH concept listed above (never fewer than 2 when the ` +
      `excerpts support it), mixing question types, difficulties and cognitive levels ` +
      `across the set so the batch is not repetitive.`;

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
            // No `temperature` override: the routed ECONOMY/STANDARD/ADVANCED
            // chat models (gpt-5.6 family) are reasoning models that only
            // support their default temperature (1) — passing 0 (the old
            // "deterministic" setting from pre-gpt-5.6 models) is rejected by
            // the API with 400 unsupported_value. Determinism instead comes
            // from the constrained JSON schema below plus validateGeneration.
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
      // The status code alone ("other") is not enough to diagnose a live
      // failure — OpenAI's error body names the actual cause (bad request,
      // auth, model access). Safe to log: it's OpenAI's own response, never
      // our secret key or student content beyond what we already sent.
      let bodySnippet = '';
      try {
        bodySnippet = (await response.text()).slice(0, 500);
      } catch {
        // best-effort only
      }
      lastError = new QuestionGenerationFailedError(
        `generation request failed with status ${response.status}${bodySnippet ? `: ${bodySnippet}` : ''}`,
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
 *
 * Skill #3: Enhanced to generate questions at different Bloom's levels.
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
    chunks: readonly GenerationChunk[],
    bloomsRequest?: BloomsLevelGenerationRequest
  ): Promise<RawGeneration> {
    const questions: RawGeneratedQuestion[] = [];

    // Determine which levels to generate
    let targetLevels: string[] = [];
    if (!bloomsRequest || bloomsRequest.targetLevels === 'all') {
      targetLevels = ['recall', 'understanding', 'application', 'analysis'];
    } else if (bloomsRequest.targetLevels === 'foundational') {
      targetLevels = ['recall', 'understanding'];
    } else if (bloomsRequest.targetLevels === 'intermediate') {
      targetLevels = ['application', 'analysis'];
    } else if (bloomsRequest.targetLevels === 'advanced') {
      targetLevels = ['evaluation', 'synthesis'];
    } else if (Array.isArray(bloomsRequest.targetLevels)) {
      targetLevels = bloomsRequest.targetLevels as string[];
    }

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

      // Skill #3: Generate questions at each target Bloom's level
      for (const level of targetLevels) {
        if (level === 'recall') {
          questions.push({
            question_type: 'single_best_answer',
            stem: `What is the normal range for ${concept.name}?`,
            difficulty: 'easy',
            cognitive_level: 'recall',
            concept_key: concept.key,
            priority_frameworks: [],
            rationale: `Students must know the definition and normal values of ${concept.name}.`,
            options: [
              {
                text: `The correct normal range for ${concept.name}.`,
                is_correct: true,
                correct_position: null,
                rationale: 'This is the established normal value.',
              },
              {
                text: 'A slightly elevated value.',
                is_correct: false,
                correct_position: null,
                rationale: 'This exceeds the normal range.',
              },
              {
                text: 'A slightly decreased value.',
                is_correct: false,
                correct_position: null,
                rationale: 'This is below the normal range.',
              },
            ],
            expected_value: null,
            tolerance: null,
            answer_unit: null,
            rounding_note: null,
            chunk_indexes: chunkIndexes,
          });
        } else if (level === 'understanding') {
          questions.push({
            question_type: 'single_best_answer',
            stem: `Explain why understanding ${concept.name} is important in nursing. What does it cause?`,
            difficulty: 'easy',
            cognitive_level: 'understanding',
            concept_key: concept.key,
            priority_frameworks: [],
            rationale: `Students must explain the pathophysiology and significance of ${concept.name}.`,
            options: [
              {
                text: `${concept.name} causes changes in cellular function that affect patient outcomes.`,
                is_correct: true,
                correct_position: null,
                rationale: 'This demonstrates understanding of the physiological impact.',
              },
              {
                text: 'It is simply a laboratory value with no clinical significance.',
                is_correct: false,
                correct_position: null,
                rationale: 'All clinical values have pathophysiological significance.',
              },
              {
                text: 'It only matters in emergency departments.',
                is_correct: false,
                correct_position: null,
                rationale: 'Clinical concepts are relevant across all care settings.',
              },
            ],
            expected_value: null,
            tolerance: null,
            answer_unit: null,
            rounding_note: null,
            chunk_indexes: chunkIndexes,
          });
        } else if (level === 'application') {
          questions.push({
            question_type: 'single_best_answer',
            stem:
              `The nurse is caring for a client with abnormal ${concept.name}. ` +
              `After reviewing the orders, which action should the nurse take first?`,
            difficulty: 'moderate',
            cognitive_level: 'application',
            concept_key: concept.key,
            priority_frameworks: ['safety', 'abc'],
            rationale:
              `Assessing the client's current status guides every subsequent intervention for ` +
              `${concept.name}; acting on stale data risks treating the wrong problem.`,
            options: [
              {
                text: 'Complete a focused reassessment and compare against baseline findings.',
                is_correct: true,
                correct_position: null,
                rationale: 'Current data must drive the intervention that follows.',
              },
              {
                text: 'Immediately administer the ordered medication without reassessment.',
                is_correct: false,
                correct_position: null,
                rationale: 'Assessment must precede intervention to ensure appropriateness.',
              },
              {
                text: 'Notify the provider of the lab value and wait for new orders.',
                is_correct: false,
                correct_position: null,
                rationale: 'Nursing assessment and stabilization come before notification.',
              },
            ],
            expected_value: null,
            tolerance: null,
            answer_unit: null,
            rounding_note: null,
            chunk_indexes: chunkIndexes,
          });
        } else if (level === 'analysis') {
          questions.push({
            question_type: 'multiple_response',
            stem:
              `A client presents with multiple abnormal labs including ${concept.name}. ` +
              `Which findings indicate a need for IMMEDIATE intervention? (Select all that apply)`,
            difficulty: 'hard',
            cognitive_level: 'analysis',
            concept_key: concept.key,
            priority_frameworks: ['abc', 'safety'],
            rationale:
              `Analysis requires distinguishing between urgent and non-urgent findings related to ` +
              `${concept.name} and its systemic effects.`,
            options: [
              {
                text: 'Cardiac arrhythmias or ECG changes.',
                is_correct: true,
                correct_position: null,
                rationale: 'Cardiac effects are life-threatening and require immediate action.',
              },
              {
                text: 'Muscle weakness or cramping.',
                is_correct: false,
                correct_position: null,
                rationale: 'While important, neuromuscular effects are managed after stabilization.',
              },
              {
                text: 'Altered mental status or confusion.',
                is_correct: true,
                correct_position: null,
                rationale: 'Neuro changes indicate systemic involvement requiring urgent intervention.',
              },
              {
                text: 'Mild elevated or decreased value on single lab.',
                is_correct: false,
                correct_position: null,
                rationale: 'Mild values without symptoms can be monitored and managed.',
              },
            ],
            expected_value: null,
            tolerance: null,
            answer_unit: null,
            rounding_note: null,
            chunk_indexes: chunkIndexes,
          });
        } else if (level === 'evaluation') {
          questions.push({
            question_type: 'single_best_answer',
            stem:
              `Evaluate the following scenario: A client has abnormal ${concept.name}, ` +
              `is asymptomatic, and three treatment options are available. Which should the nurse prioritize?`,
            difficulty: 'hard',
            cognitive_level: 'evaluation',
            concept_key: concept.key,
            priority_frameworks: ['safety', 'ati_prioritization'],
            rationale:
              `Evaluation involves making clinical judgments based on evidence, risk stratification, ` +
              `and patient-centered care principles applied to ${concept.name}.`,
            options: [
              {
                text:
                  'The most conservative approach that avoids medication unless symptoms develop.',
                is_correct: true,
                correct_position: null,
                rationale:
                  'Asymptomatic patients tolerate many abnormalities; overtreatment risks harm.',
              },
              {
                text: 'The most aggressive intervention regardless of symptoms.',
                is_correct: false,
                correct_position: null,
                rationale: 'Aggressive treatment of asymptomatic conditions increases risk without benefit.',
              },
              {
                text: 'Whichever option the previous nurse used.',
                is_correct: false,
                correct_position: null,
                rationale: 'Each patient requires individualized clinical judgment.',
              },
            ],
            expected_value: null,
            tolerance: null,
            answer_unit: null,
            rounding_note: null,
            chunk_indexes: chunkIndexes,
          });
        }
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
    const route = routeAiTask({ task: 'QUESTION_GENERATION_ROUTINE', complexity: 'MEDIUM' }, env);
    return new OpenAIQuestionGenerationProvider(apiKey, env.QUESTION_MODEL ?? route.model);
  }
  if (provider === 'scripted') {
    // Deterministic keyless generation for development only.
    return new ScriptedQuestionGenerationProvider();
  }
  throw new Error(`Unknown QUESTION_PROVIDER "${provider}".`);
}
