/**
 * @avidia/ai-router — centralized, provider-independent, task-aware and
 * complexity-aware AI model router (v1).
 *
 * routeAiTask() picks a model; executeAiTask() additionally runs it with
 * bounded retry, safe fallback, and observability. Every AI call site in the
 * product should go through one of these two — never construct or hard-code
 * a model id at a call site (spec section 5).
 */
export * from './types';
export * from './router';
export * from './execute';
export * from './logger';
export * from './pricing';
export { resolveProviderCatalog, AiRouterConfigError } from './config';
export type { AiProviderCatalog } from './config';
export { OPENAI_CHAT_MODELS, OPENAI_EMBEDDING_MODEL, allOpenAiModelIds } from './openai';
export { baseTierForTask } from './tiers';
