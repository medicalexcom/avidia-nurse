import { resolveProviderCatalog, AiRouterConfigError } from './config';
import { routeAiTask } from './router';

const ENV = {}; // no overrides — exercises real OpenAI defaults from openai.ts

describe('routeAiTask — EMBEDDING (SPECIALIZED)', () => {
  it('resolves the embedding model with no fallback', () => {
    const result = routeAiTask({ task: 'EMBEDDING', complexity: 'LOW' }, ENV);
    expect(result).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
      tier: 'SPECIALIZED',
      fallback: null,
    });
  });
});

describe('routeAiTask — fixed-tier tasks', () => {
  it.each([
    ['CONCEPT_EXTRACTION', 'ECONOMY', 'STANDARD'],
    ['QUESTION_GENERATION_ROUTINE', 'ECONOMY', 'STANDARD'],
    ['QUESTION_GENERATION_COMPLEX', 'STANDARD', 'ADVANCED'],
    ['BASIC_EXPLANATION', 'ECONOMY', 'STANDARD'],
    ['RAG_ANSWER', 'STANDARD', 'ADVANCED'],
    ['DEEP_TUTORING', 'ADVANCED', null],
    ['CLINICAL_REASONING_EVALUATION', 'ADVANCED', null],
    ['SIMULATION_CASE_GENERATION', 'ADVANCED', null],
    ['SIMULATION_DIALOGUE', 'STANDARD', 'ADVANCED'],
  ] as const)('%s routes to %s with fallback %s', (task, expectedTier, expectedFallbackTier) => {
    const result = routeAiTask({ task, complexity: 'MEDIUM' }, ENV);
    expect(result.tier).toBe(expectedTier);
    expect(result.provider).toBe('openai');
    if (expectedFallbackTier === null) {
      expect(result.fallback).toBeNull();
    } else {
      expect(result.fallback?.tier).toBe(expectedFallbackTier);
    }
  });
});

describe('routeAiTask — CASE_STUDY_GENERATION (complexity-sensitive)', () => {
  it('routes LOW/MEDIUM to STANDARD and HIGH to ADVANCED', () => {
    expect(routeAiTask({ task: 'CASE_STUDY_GENERATION', complexity: 'LOW' }, ENV).tier).toBe(
      'STANDARD'
    );
    expect(routeAiTask({ task: 'CASE_STUDY_GENERATION', complexity: 'MEDIUM' }, ENV).tier).toBe(
      'STANDARD'
    );
    expect(routeAiTask({ task: 'CASE_STUDY_GENERATION', complexity: 'HIGH' }, ENV).tier).toBe(
      'ADVANCED'
    );
  });

  it('HIGH complexity (already ADVANCED) has no fallback', () => {
    expect(
      routeAiTask({ task: 'CASE_STUDY_GENERATION', complexity: 'HIGH' }, ENV).fallback
    ).toBeNull();
  });
});

describe('routeAiTask — QUESTION_REPAIR ("same tier, escalate only if necessary")', () => {
  it('defaults to ECONOMY with no context', () => {
    const result = routeAiTask({ task: 'QUESTION_REPAIR', complexity: 'MEDIUM' }, ENV);
    expect(result.tier).toBe('ECONOMY');
  });

  it('floors at the originating tier via requirements.minTier', () => {
    const result = routeAiTask(
      { task: 'QUESTION_REPAIR', complexity: 'MEDIUM', requirements: { minTier: 'STANDARD' } },
      ENV
    );
    expect(result.tier).toBe('STANDARD');
    expect(result.fallback?.tier).toBe('ADVANCED');
  });

  it('never lowers tier when minTier is below the computed tier', () => {
    // QUESTION_GENERATION_COMPLEX is already STANDARD; a lower minTier must not downgrade it.
    const result = routeAiTask(
      {
        task: 'QUESTION_GENERATION_COMPLEX',
        complexity: 'MEDIUM',
        requirements: { minTier: 'ECONOMY' },
      },
      ENV
    );
    expect(result.tier).toBe('STANDARD');
  });
});

describe('routeAiTask — fallback never downgrades', () => {
  it('ADVANCED tasks have no fallback at all (nothing above ADVANCED)', () => {
    for (const task of [
      'DEEP_TUTORING',
      'CLINICAL_REASONING_EVALUATION',
      'SIMULATION_CASE_GENERATION',
    ] as const) {
      expect(routeAiTask({ task, complexity: 'HIGH' }, ENV).fallback).toBeNull();
    }
  });

  it('requirements.allowFallback = false suppresses fallback even for an ECONOMY task', () => {
    const result = routeAiTask(
      { task: 'CONCEPT_EXTRACTION', complexity: 'MEDIUM', requirements: { allowFallback: false } },
      ENV
    );
    expect(result.fallback).toBeNull();
  });
});

describe('resolveProviderCatalog — env overrides and compatibility', () => {
  it('uses openai defaults with no env', () => {
    const catalog = resolveProviderCatalog({});
    expect(catalog.chatModels.ECONOMY).toBe('gpt-5.6-luna');
    expect(catalog.chatModels.STANDARD).toBe('gpt-5.6-terra');
    expect(catalog.chatModels.ADVANCED).toBe('gpt-5.6-sol');
    expect(catalog.embeddingModel).toBe('text-embedding-3-small');
  });

  it('honors per-tier AI_MODEL_* overrides independently', () => {
    const catalog = resolveProviderCatalog({ AI_MODEL_ECONOMY: 'gpt-5-mini-preview' });
    expect(catalog.chatModels.ECONOMY).toBe('gpt-5-mini-preview');
    expect(catalog.chatModels.STANDARD).toBe('gpt-5.6-terra'); // untouched
  });

  it('routeAiTask picks up an AI_MODEL_* override', () => {
    const result = routeAiTask(
      { task: 'CONCEPT_EXTRACTION', complexity: 'MEDIUM' },
      { AI_MODEL_ECONOMY: 'gpt-5-mini-preview' }
    );
    expect(result.model).toBe('gpt-5-mini-preview');
  });

  it('throws AiRouterConfigError for an unknown AI_PROVIDER', () => {
    expect(() => resolveProviderCatalog({ AI_PROVIDER: 'not-a-real-provider' })).toThrow(
      AiRouterConfigError
    );
  });
});
