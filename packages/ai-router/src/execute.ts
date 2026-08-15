import { emitAiRouterEvent } from './logger';
import { estimateCostUsd } from './pricing';
import { routeAiTask } from './router';
import { AiModelChoice, AiTask, AiTaskRequest } from './types';

/**
 * Failure/fallback execution around routeAiTask (spec section 6). This file
 * owns retry/backoff and fallback escalation and observability; it does NOT
 * know how to build a provider request or parse a provider response — the
 * caller supplies that as `attempt`, so this stays reusable for chat
 * completions, embeddings, or any future provider shape.
 */

export interface AiAttemptSuccess<T> {
  ok: true;
  value: T;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Short, machine-readable, student-invisible failure codes (spec section 6):
 * http_429 (rate limit), http_5xx (server error), timeout, network_error,
 * quota_exceeded (billing/quota — retrying the SAME model will not help, but
 * a different model/provider might), invalid_response (schema/parse
 * failure — usually not worth retrying the same way twice), other.
 */
export type AiFailureReason =
  | 'http_429'
  | 'http_5xx'
  | 'timeout'
  | 'network_error'
  | 'quota_exceeded'
  | 'invalid_response'
  | 'other';

export interface AiAttemptFailure {
  ok: false;
  reason: AiFailureReason;
  /** True when calling `attempt` again against the SAME model is worth trying. quota_exceeded is always false here — see reason above. */
  retryableSameModel: boolean;
  /** Internal-only detail for logs; never shown to a student. */
  detail: string;
}

export type AiAttemptOutcome<T> = AiAttemptSuccess<T> | AiAttemptFailure;

/**
 * Thrown when a task fails after exhausting retries on its primary model AND
 * its fallback (or has no fallback). `.message` is always the generic,
 * student-safe string; `.detail` carries the real reason for logs/ops only
 * (mirrors the messages.ts errorMessage()/internalDetailForError() split
 * used by the worker — never let a raw provider error reach a student).
 */
export class AiTaskFailedError extends Error {
  constructor(
    readonly task: AiTask,
    readonly detail: string
  ) {
    super('This AI task could not be completed right now. Please try again shortly.');
    this.name = 'AiTaskFailedError';
  }
}

const DEFAULT_MAX_ATTEMPTS_PER_MODEL = 3;
const DEFAULT_BACKOFF_MS = 500;

export interface ExecuteAiTaskOptions<T> {
  request: AiTaskRequest;
  /** Perform ONE call against the given model choice and classify the outcome. */
  attempt: (choice: AiModelChoice) => Promise<AiAttemptOutcome<T>>;
  env?: Record<string, string | undefined>;
  maxAttemptsPerModel?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ExecuteAiTaskResult<T> {
  value: T;
  choice: AiModelChoice;
  usedFallback: boolean;
}

export async function executeAiTask<T>(options: ExecuteAiTaskOptions<T>): Promise<ExecuteAiTaskResult<T>> {
  const {
    request,
    attempt,
    env = process.env,
    maxAttemptsPerModel = DEFAULT_MAX_ATTEMPTS_PER_MODEL,
    sleep = defaultSleep,
  } = options;

  const route = routeAiTask(request, env);
  const primaryChoice: AiModelChoice = { provider: route.provider, model: route.model, tier: route.tier };

  const primary = await runAgainstModel({
    request,
    choice: primaryChoice,
    attempt,
    maxAttemptsPerModel,
    sleep,
    usedFallback: false,
  });
  if (primary.ok) {
    return { value: primary.value, choice: primaryChoice, usedFallback: false };
  }

  if (!route.fallback) {
    throw new AiTaskFailedError(request.task, primary.detail);
  }

  const fallback = await runAgainstModel({
    request,
    choice: route.fallback,
    attempt,
    maxAttemptsPerModel,
    sleep,
    usedFallback: true,
  });
  if (fallback.ok) {
    return { value: fallback.value, choice: route.fallback, usedFallback: true };
  }
  throw new AiTaskFailedError(
    request.task,
    `primary (${primaryChoice.model}) failed: ${primary.detail}; fallback (${route.fallback.model}) failed: ${fallback.detail}`
  );
}

interface RunAgainstModelOptions<T> {
  request: AiTaskRequest;
  choice: AiModelChoice;
  attempt: (choice: AiModelChoice) => Promise<AiAttemptOutcome<T>>;
  maxAttemptsPerModel: number;
  sleep: (ms: number) => Promise<void>;
  usedFallback: boolean;
}

type RunOutcome<T> = { ok: true; value: T } | { ok: false; detail: string };

/** Bounded retry with backoff against ONE model choice; emits one observability event per attempt. */
async function runAgainstModel<T>(options: RunAgainstModelOptions<T>): Promise<RunOutcome<T>> {
  const { request, choice, attempt, maxAttemptsPerModel, sleep, usedFallback } = options;
  let lastDetail = 'unknown failure';
  for (let attemptNumber = 1; attemptNumber <= maxAttemptsPerModel; attemptNumber += 1) {
    const startedAt = Date.now();
    const outcome = await attempt(choice);
    const latencyMs = Date.now() - startedAt;

    if (outcome.ok) {
      emitAiRouterEvent({
        task: request.task,
        complexity: request.complexity,
        tier: choice.tier,
        provider: choice.provider,
        model: choice.model,
        latencyMs,
        tokens: outcome.usage && { input: outcome.usage.inputTokens, output: outcome.usage.outputTokens },
        estimatedCostUsd: outcome.usage && estimateCostUsd(choice.model, outcome.usage),
        retryCount: attemptNumber - 1,
        usedFallback,
        success: true,
      });
      return { ok: true, value: outcome.value };
    }

    lastDetail = outcome.detail;
    emitAiRouterEvent({
      task: request.task,
      complexity: request.complexity,
      tier: choice.tier,
      provider: choice.provider,
      model: choice.model,
      latencyMs,
      retryCount: attemptNumber - 1,
      usedFallback,
      success: false,
      failureReason: outcome.reason,
    });

    const hasAttemptsLeft = attemptNumber < maxAttemptsPerModel;
    if (!outcome.retryableSameModel || !hasAttemptsLeft) {
      return { ok: false, detail: lastDetail };
    }
    await sleep(DEFAULT_BACKOFF_MS * attemptNumber);
  }
  return { ok: false, detail: lastDetail };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
