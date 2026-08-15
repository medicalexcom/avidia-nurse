import { AiComplexity, AiTask, AiTier } from './types';

/**
 * Privacy-safe observability event (spec section 8). Deliberately has NO
 * field for prompt/response/course content — only shape and outcome. Never
 * add a field here that could carry a stem, an excerpt, or a student
 * identifier; if a future caller needs to correlate an event with a
 * document/course, pass an opaque id the caller already scoped, not content.
 */
export interface AiRouterEvent {
  task: AiTask;
  complexity: AiComplexity;
  tier: AiTier;
  provider: string;
  model: string;
  /** Wall-clock time for the attempt that produced this event, in ms. */
  latencyMs: number;
  tokens?: { input: number; output: number };
  estimatedCostUsd?: number;
  /** 0 for the first attempt; increments per same-model retry. */
  retryCount: number;
  /** True when this event is for a fallback-tier attempt, not the primary. */
  usedFallback: boolean;
  success: boolean;
  /** Present only on failure; a short machine reason (e.g. "http_429", "timeout"), never a raw provider message. */
  failureReason?: string;
}

export type AiRouterEventSink = (event: AiRouterEvent) => void;

/** Default sink: one structured JSON line per event, safe for any log pipeline. */
export const consoleAiRouterEventSink: AiRouterEventSink = (event) => {
  console.log(JSON.stringify({ type: 'ai_router_event', ...event }));
};

let activeSink: AiRouterEventSink = consoleAiRouterEventSink;

/** Swap the event sink (tests, or a future structured-logging backend). Returns the previous sink. */
export function setAiRouterEventSink(sink: AiRouterEventSink): AiRouterEventSink {
  const previous = activeSink;
  activeSink = sink;
  return previous;
}

export function emitAiRouterEvent(event: AiRouterEvent): void {
  activeSink(event);
}
