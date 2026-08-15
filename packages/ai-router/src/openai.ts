import { AiTier } from './types';

/**
 * The ONLY file in this package (and, after the M7/M6/M5 gateway migration,
 * in the whole repo) allowed to contain a literal OpenAI model id. Every
 * other call site asks the router for a TASK's model; nobody else needs to
 * know these strings.
 *
 * Verified live against OpenAI's official model documentation
 * (platform.openai.com/docs/models, developers.openai.com/api/docs/models,
 * and the embeddings guide) on 2026-08-15 — NOT carried forward from M7's
 * original defaults, per this task's explicit instruction not to assume
 * historical models are still current. GPT-5 / GPT-5 mini / GPT-5.1, which
 * were current at earlier points, do not appear in the current model
 * catalog or comparison page; the GPT-5.6 family (sol / terra / luna) is the
 * current three-tier lineup and is what these tiers resolve to. Re-verify
 * this file (and re-run `pnpm --filter @avidia/worker verify-models`, which
 * checks these ids against the configured OpenAI account) whenever OpenAI
 * ships a new model generation — see docs/AI_MODEL_ROUTING.md.
 *
 *   gpt-5.6-luna  $0.20 / $1.20   per 1M input/output tokens — "cost-sensitive,
 *                 high-volume workloads" (nano-equivalent)
 *   gpt-5.6-terra $2.00 / $12.00  per 1M input/output tokens — "balances
 *                 intelligence and cost" (mini-equivalent)
 *   gpt-5.6-sol   $5.00 / $30.00  per 1M input/output tokens — "frontier
 *                 model for complex professional work"
 * All three: 1,050,000 token context window, 128,000 max output tokens,
 * strict JSON-schema structured outputs supported.
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
