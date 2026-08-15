import { resolveProviderCatalog } from './config';
import { baseTierForTask } from './tiers';
import { AiModelChoice, AiRouteResult, AiTaskRequest, AiTier, CHAT_TIER_RANK } from './types';

/**
 * The router contract (spec section 5). Pure function — no I/O, no retry, no
 * network. Given a task, its complexity, and optional requirements, resolve
 * exactly which model runs it and what to try next if it fails. Screens and
 * packages call this (or the higher-level `executeAiTask` in execute.ts)
 * instead of ever writing a model id.
 */
export function routeAiTask(request: AiTaskRequest, env: Record<string, string | undefined> = process.env): AiRouteResult {
  const catalog = resolveProviderCatalog(env);

  if (request.task === 'EMBEDDING') {
    // SPECIALIZED: not on the chat tier ladder, no fallback — a different
    // embedding model produces incomparable vectors (see openai.ts).
    return {
      provider: catalog.provider,
      model: catalog.embeddingModel,
      tier: 'SPECIALIZED',
      fallback: null,
    };
  }

  const requirements = request.requirements ?? {};
  let tier = baseTierForTask(request.task, request.complexity);
  if (requirements.minTier && requirements.minTier !== 'SPECIALIZED') {
    tier = rankToTier(Math.max(CHAT_TIER_RANK[tier], CHAT_TIER_RANK[requirements.minTier]));
  }

  const primary: AiModelChoice = {
    provider: catalog.provider,
    model: catalog.chatModels[tier],
    tier,
  };

  const fallback = resolveFallback(tier, catalog.chatModels, requirements.allowFallback ?? true);

  return { ...primary, fallback };
}

/**
 * The fallback is always the next tier UP (never a downgrade — spec section
 * 6: "do not downgrade a genuinely ADVANCED clinical-authoring request to a
 * model that cannot satisfy the required schema/reasoning quality" — applied
 * uniformly: a cheaper task escalating to a pricier-but-capable model is
 * always safe; the reverse never is). There is nothing above ADVANCED, so
 * ADVANCED tasks have no fallback tier — a caller can retry the same model,
 * but the router will not suggest a weaker one.
 */
function resolveFallback(
  tier: Exclude<AiTier, 'SPECIALIZED'>,
  chatModels: Record<Exclude<AiTier, 'SPECIALIZED'>, string>,
  allowFallback: boolean
): AiModelChoice | null {
  if (!allowFallback) {
    return null;
  }
  const nextRank = CHAT_TIER_RANK[tier] + 1;
  if (nextRank > CHAT_TIER_RANK.ADVANCED) {
    return null;
  }
  const nextTier = rankToTier(nextRank);
  return { provider: 'openai', model: chatModels[nextTier], tier: nextTier };
}

function rankToTier(rank: number): Exclude<AiTier, 'SPECIALIZED'> {
  const entry = (Object.entries(CHAT_TIER_RANK) as [Exclude<AiTier, 'SPECIALIZED'>, number][]).find(
    ([, r]) => r === rank
  );
  if (!entry) {
    throw new Error(`No chat tier at rank ${rank}.`);
  }
  return entry[0];
}
