/**
 * Per-model pricing (USD per 1,000,000 tokens), for cost estimation in
 * observability only (spec section 8: "estimated cost where possible"). Not
 * used for routing decisions or billing — a best-effort estimate from
 * OpenAI's published standard API pricing. This metadata is operational
 * telemetry only and should be reviewed whenever a model is changed.
 */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export const OPENAI_PRICING: Record<string, ModelPricing> = {
  // 2026-08: gpt-5.6 family pricing (see openai.ts for the matching model-id update).
  'gpt-5.6-luna': { inputPer1M: 0.2, outputPer1M: 1.2 },
  'gpt-5.6-terra': { inputPer1M: 2.0, outputPer1M: 12.0 },
  'gpt-5.6-sol': { inputPer1M: 5.0, outputPer1M: 30.0 },
  // Embeddings have no separate output cost; OpenAI bills input tokens only.
  'text-embedding-3-small': { inputPer1M: 0.02, outputPer1M: 0 },
};

/** Best-effort cost estimate in USD; undefined when the model has no known pricing. */
export function estimateCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number }
): number | undefined {
  const pricing = OPENAI_PRICING[model];
  if (!pricing) {
    return undefined;
  }
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPer1M +
    (usage.outputTokens / 1_000_000) * pricing.outputPer1M
  );
}
