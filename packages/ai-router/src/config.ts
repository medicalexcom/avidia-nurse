import { OPENAI_CHAT_MODELS, OPENAI_EMBEDDING_MODEL } from './openai';
import { AiTier } from './types';

/**
 * Server-only AI router configuration (spec section 7). Every variable here
 * is read from `process.env` (or an equivalent server env map) by the
 * worker/backend only — nothing in this file is ever imported by client
 * (Expo) code, and nothing here may be prefixed EXPO_PUBLIC_.
 *
 * AI_PROVIDER selects the provider catalog (only "openai" exists today; the
 * shape exists so a second provider is a config addition, not a rewrite).
 * AI_MODEL_ECONOMY / AI_MODEL_STANDARD / AI_MODEL_ADVANCED / AI_MODEL_EMBEDDING
 * override individual tier models without code changes (e.g. to pin a model
 * during a provider rollout, or to point a tier at a cheaper/newer model the
 * moment OpenAI ships one, ahead of the next code deploy).
 *
 * Backward compatibility (spec section 7: "maintain reasonable compatibility
 * ... or migrate them explicitly"): the pre-router variables CONCEPT_MODEL,
 * QUESTION_MODEL and EMBEDDING_PROVIDER/EMBEDDING_MODEL keep working exactly
 * as before — set at the gateway call site, not here — so no founder action
 * is required by this change. See gateway.ts in packages/knowledge and
 * packages/assessment for exactly how they take precedence over the router.
 */

export interface AiProviderCatalog {
  provider: string;
  chatModels: Record<Exclude<AiTier, 'SPECIALIZED'>, string>;
  embeddingModel: string;
}

const PROVIDERS: Record<string, () => AiProviderCatalog> = {
  openai: () => ({
    provider: 'openai',
    chatModels: { ...OPENAI_CHAT_MODELS },
    embeddingModel: OPENAI_EMBEDDING_MODEL,
  }),
};

export class AiRouterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiRouterConfigError';
  }
}

/**
 * Build the active provider catalog from server env. Applies AI_MODEL_*
 * overrides on top of the provider's defaults, tier by tier, so setting one
 * override never silently resets the others.
 */
export function resolveProviderCatalog(env: Record<string, string | undefined>): AiProviderCatalog {
  const providerName = env.AI_PROVIDER ?? 'openai';
  const factory = PROVIDERS[providerName];
  if (!factory) {
    throw new AiRouterConfigError(
      `Unknown AI_PROVIDER "${providerName}". Known providers: ${Object.keys(PROVIDERS).join(', ')}.`
    );
  }
  const base = factory();
  return {
    provider: base.provider,
    chatModels: {
      ECONOMY: env.AI_MODEL_ECONOMY ?? base.chatModels.ECONOMY,
      STANDARD: env.AI_MODEL_STANDARD ?? base.chatModels.STANDARD,
      ADVANCED: env.AI_MODEL_ADVANCED ?? base.chatModels.ADVANCED,
    },
    embeddingModel: env.AI_MODEL_EMBEDDING ?? base.embeddingModel,
  };
}
