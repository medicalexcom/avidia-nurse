import { AiTier } from './types';

/**
 * The ONLY file in this package (and, after the M7/M6/M5 gateway migration,
 * in the whole repo) allowed to contain a literal OpenAI model id. Every
 * other call site asks the router for a TASK's model; nobody else needs to
 * know these strings.
 *
 * These are real OpenAI API identifiers rather than product-family names.
 * Live availability is account-specific and MUST be checked with
 * `pnpm --filter @avidia/worker verify-models` before deploying. Environment
 * overrides make it possible to pin another model without a code change.
 *
 * 2026-08: updated from the retired gpt-5-mini / gpt-5.1 / gpt-5.2 ids to the
 * current gpt-5.6 family (Ask Avidia fix — every chat completion was failing
 * because those ids no longer resolve on OpenAI's API; see pricing.ts for the
 * matching cost update). Luna/Terra/Sol map cleanly onto the existing
 * ECONOMY/STANDARD/ADVANCED tiers by OpenAI's own cost/capability ordering.
 */
export const OPENAI_CHAT_MODELS: Record<Exclude<AiTier, 'SPECIALIZED'>, string> = {
  ECONOMY: 'gpt-5.6-luna',
  STANDARD: 'gpt-5.6-terra',
  ADVANCED: 'gpt-5.6-sol',
};

/**
 * Embedding model (spec section 3: "preserve existing compatible embedding
 * configuration"). `text-embedding-3-small` remains current and available
 * per OpenAI's embeddings guide — unchanged from M5, and it must stay
 * unchanged: a different embedding model produces vectors that are not
 * comparable to the ones already stored in source_chunks.embedding
 * (ADR-0012), so this is a deliberate exception to "use current models."
 */
export const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

/** Every model id this file can hand out, for the account-verification script. */
export function allOpenAiModelIds(): string[] {
  return [...Object.values(OPENAI_CHAT_MODELS), OPENAI_EMBEDDING_MODEL];
}
