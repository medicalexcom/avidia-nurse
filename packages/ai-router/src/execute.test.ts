import { executeAiTask, AiAttemptOutcome, AiTaskFailedError } from './execute';
import { setAiRouterEventSink, AiRouterEvent } from './logger';
import { AiModelChoice } from './types';

const ENV = {}; // no overrides — exercises real OpenAI defaults

/** Collects every observability event emitted during a test; restored in afterEach. */
function captureEvents(): AiRouterEvent[] {
  const events: AiRouterEvent[] = [];
  setAiRouterEventSink((event) => events.push(event));
  return events;
}

afterEach(() => {
  // Reset to the default console sink so tests never leak a capturing sink into each other.
  setAiRouterEventSink((event) => {
    console.log(JSON.stringify({ type: 'ai_router_event', ...event }));
  });
});

/** No-op sleep so retry/backoff tests run instantly instead of waiting on real timers. */
async function instantSleep(): Promise<void> {
  return undefined;
}

describe('executeAiTask — success paths', () => {
  it('returns the value on first attempt against the primary model, no retries, no fallback', async () => {
    const events = captureEvents();
    const attempt = jest.fn(async (): Promise<AiAttemptOutcome<string>> => ({ ok: true, value: 'concepts-json' }));

    const result = await executeAiTask({
      request: { task: 'CONCEPT_EXTRACTION', complexity: 'MEDIUM' },
      attempt,
      env: ENV,
      sleep: instantSleep,
    });

    expect(result.value).toBe('concepts-json');
    expect(result.usedFallback).toBe(false);
    expect(result.choice.tier).toBe('ECONOMY');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ success: true, retryCount: 0, usedFallback: false });
  });

  it('retries the SAME model on a retryable failure (e.g. http_429) and succeeds within the attempt budget', async () => {
    const events = captureEvents();
    let calls = 0;
    const attempt = jest.fn(async (_choice: AiModelChoice): Promise<AiAttemptOutcome<string>> => {
      calls += 1;
      if (calls < 3) {
        return { ok: false, reason: 'http_429', retryableSameModel: true, detail: 'rate limited' };
      }
      return { ok: true, value: 'ok-on-third-try' };
    });

    const result = await executeAiTask({
      request: { task: 'RAG_ANSWER', complexity: 'MEDIUM' },
      attempt,
      env: ENV,
      sleep: instantSleep,
    });

    expect(result.value).toBe('ok-on-third-try');
    expect(result.usedFallback).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(3);
    // Same model on every attempt — retry never silently swaps models.
    const modelsUsed = new Set(attempt.mock.calls.map(([choice]: [AiModelChoice]) => choice.model));
    expect(modelsUsed.size).toBe(1);
    expect(events.map((e) => e.retryCount)).toEqual([0, 1, 2]);
    expect(events.map((e) => e.success)).toEqual([false, false, true]);
  });

  it('escalates to the fallback model after the primary exhausts its retries, and succeeds there', async () => {
    const events = captureEvents();
    const attempt = jest.fn(async (choice: AiModelChoice): Promise<AiAttemptOutcome<string>> => {
      if (choice.tier === 'ECONOMY') {
        return { ok: false, reason: 'http_5xx', retryableSameModel: true, detail: 'server error' };
      }
      return { ok: true, value: `answered-by-${choice.tier}` };
    });

    const result = await executeAiTask({
      request: { task: 'BASIC_EXPLANATION', complexity: 'MEDIUM' },
      attempt,
      env: ENV,
      sleep: instantSleep,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.choice.tier).toBe('STANDARD'); // BASIC_EXPLANATION fallback is one tier up from ECONOMY
    expect(result.value).toBe('answered-by-STANDARD');
    // 3 failing attempts on primary (default max) + 1 succeeding attempt on fallback.
    expect(attempt).toHaveBeenCalledTimes(4);
    expect(events.filter((e) => e.usedFallback).length).toBe(1);
  });

  it('a non-retryable failure (e.g. invalid_response) short-circuits to fallback without exhausting the attempt budget', async () => {
    const attempt = jest.fn(async (choice: AiModelChoice): Promise<AiAttemptOutcome<string>> => {
      if (choice.tier === 'ECONOMY') {
        return { ok: false, reason: 'invalid_response', retryableSameModel: false, detail: 'schema mismatch' };
      }
      return { ok: true, value: 'fallback-value' };
    });

    const result = await executeAiTask({
      request: { task: 'QUESTION_GENERATION_ROUTINE', complexity: 'MEDIUM' },
      attempt,
      env: ENV,
      sleep: instantSleep,
    });

    expect(result.usedFallback).toBe(true);
    // Exactly ONE attempt against the primary — retryableSameModel:false means "don't retry the same model".
    const primaryAttempts = attempt.mock.calls.filter(([choice]: [AiModelChoice]) => choice.tier === 'ECONOMY');
    expect(primaryAttempts).toHaveLength(1);
  });

  it('quota_exceeded is never retried against the same model — it escalates to fallback immediately', async () => {
    const attempt = jest.fn(async (choice: AiModelChoice): Promise<AiAttemptOutcome<string>> => {
      if (choice.tier === 'ECONOMY') {
        return { ok: false, reason: 'quota_exceeded', retryableSameModel: false, detail: 'billing quota exhausted' };
      }
      return { ok: true, value: 'fallback-after-quota' };
    });

    const result = await executeAiTask({
      request: { task: 'CONCEPT_EXTRACTION', complexity: 'MEDIUM' },
      attempt,
      env: ENV,
      sleep: instantSleep,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.value).toBe('fallback-after-quota');
    const primaryAttempts = attempt.mock.calls.filter(([choice]: [AiModelChoice]) => choice.tier === 'ECONOMY');
    expect(primaryAttempts).toHaveLength(1);
  });
});

describe('executeAiTask — exhaustion / student-safe failure', () => {
  it('throws AiTaskFailedError with a generic, student-safe message when primary AND fallback both exhaust retries', async () => {
    const attempt = jest.fn(
      async (): Promise<AiAttemptOutcome<string>> => ({
        ok: false,
        reason: 'http_5xx',
        retryableSameModel: true,
        detail: 'upstream 503 from provider — internal only',
      })
    );

    await expect(
      executeAiTask({
        request: { task: 'BASIC_EXPLANATION', complexity: 'MEDIUM' },
        attempt,
        env: ENV,
        sleep: instantSleep,
      })
    ).rejects.toThrow(AiTaskFailedError);

    try {
      await executeAiTask({
        request: { task: 'BASIC_EXPLANATION', complexity: 'MEDIUM' },
        attempt,
        env: ENV,
        sleep: instantSleep,
      });
      fail('expected executeAiTask to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AiTaskFailedError);
      const failed = error as AiTaskFailedError;
      // Student-safe: generic message only, no provider/model/status-code detail leaks into .message.
      expect(failed.message).toBe('This AI task could not be completed right now. Please try again shortly.');
      expect(failed.message).not.toMatch(/503|provider|upstream/i);
      // The real reason is still available internally for ops/logs.
      expect(failed.detail).toMatch(/upstream 503 from provider/);
      expect(failed.task).toBe('BASIC_EXPLANATION');
    }
  });

  it('throws AiTaskFailedError immediately (no fallback attempted) when the task has no fallback tier (e.g. DEEP_TUTORING, already ADVANCED)', async () => {
    const attempt = jest.fn(
      async (): Promise<AiAttemptOutcome<string>> => ({
        ok: false,
        reason: 'timeout',
        retryableSameModel: true,
        detail: 'timed out',
      })
    );

    await expect(
      executeAiTask({
        request: { task: 'DEEP_TUTORING', complexity: 'HIGH' },
        attempt,
        env: ENV,
        sleep: instantSleep,
      })
    ).rejects.toThrow(AiTaskFailedError);

    // DEEP_TUTORING has no fallback: only the primary's own attempt budget (default 3) is used.
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('throws AiTaskFailedError immediately when allowFallback is false, even though a fallback tier would otherwise exist', async () => {
    const attempt = jest.fn(
      async (_choice: AiModelChoice): Promise<AiAttemptOutcome<string>> => ({
        ok: false,
        reason: 'http_429',
        retryableSameModel: true,
        detail: 'rate limited',
      })
    );

    await expect(
      executeAiTask({
        request: { task: 'CONCEPT_EXTRACTION', complexity: 'MEDIUM', requirements: { allowFallback: false } },
        attempt,
        env: ENV,
        sleep: instantSleep,
      })
    ).rejects.toThrow(AiTaskFailedError);

    const tiersAttempted = new Set(attempt.mock.calls.map(([choice]: [AiModelChoice]) => choice.tier));
    expect(tiersAttempted).toEqual(new Set(['ECONOMY']));
  });
});

describe('executeAiTask — retry/backoff mechanics', () => {
  it('respects a custom maxAttemptsPerModel and sleeps between same-model retries with increasing backoff', async () => {
    const sleepCalls: number[] = [];
    const attempt = jest.fn(
      async (): Promise<AiAttemptOutcome<string>> => ({
        ok: false,
        reason: 'http_5xx',
        retryableSameModel: true,
        detail: 'server error',
      })
    );

    await expect(
      executeAiTask({
        request: { task: 'DEEP_TUTORING', complexity: 'HIGH' }, // no fallback, isolates primary-model retry behavior
        attempt,
        env: ENV,
        maxAttemptsPerModel: 2,
        sleep: async (ms: number) => {
          sleepCalls.push(ms);
        },
      })
    ).rejects.toThrow(AiTaskFailedError);

    expect(attempt).toHaveBeenCalledTimes(2);
    // One sleep between the two attempts, backoff scaled by attempt number.
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBeGreaterThan(0);
  });

  it('does not sleep after the final attempt (no wasted delay once the budget is exhausted)', async () => {
    let sleepCount = 0;
    const attempt = jest.fn(
      async (): Promise<AiAttemptOutcome<string>> => ({
        ok: false,
        reason: 'timeout',
        retryableSameModel: true,
        detail: 'timed out',
      })
    );

    await expect(
      executeAiTask({
        request: { task: 'DEEP_TUTORING', complexity: 'HIGH' },
        attempt,
        env: ENV,
        maxAttemptsPerModel: 3,
        sleep: async () => {
          sleepCount += 1;
        },
      })
    ).rejects.toThrow(AiTaskFailedError);

    // 3 attempts, sleep only BETWEEN attempts => 2 sleeps, not 3.
    expect(sleepCount).toBe(2);
  });
});

describe('executeAiTask — observability carries no course/prompt content', () => {
  it('every emitted event is limited to routing/outcome metadata fields', async () => {
    const events = captureEvents();
    const attempt = jest.fn(
      async (): Promise<AiAttemptOutcome<string>> => ({
        ok: true,
        value: 'a real course-content answer that must never appear in telemetry',
        usage: { inputTokens: 1000, outputTokens: 200 },
      })
    );

    await executeAiTask({
      request: { task: 'CONCEPT_EXTRACTION', complexity: 'MEDIUM' },
      attempt,
      env: ENV,
      sleep: instantSleep,
    });

    expect(events).toHaveLength(1);
    const allowedKeys = new Set([
      'task',
      'complexity',
      'tier',
      'provider',
      'model',
      'latencyMs',
      'tokens',
      'estimatedCostUsd',
      'retryCount',
      'usedFallback',
      'success',
      'failureReason',
    ]);
    const [event] = events;
    if (!event) {
      throw new Error('expected one event to have been emitted');
    }
    for (const key of Object.keys(event)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
    expect(JSON.stringify(event)).not.toMatch(/course-content answer/);
    expect(event.estimatedCostUsd).toBeGreaterThan(0);
  });
});
