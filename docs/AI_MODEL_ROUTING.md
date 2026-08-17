# AI model routing (`@avidia/ai-router`)

Every AI call in the product goes through `@avidia/ai-router` instead of a
hard-coded provider/model id. This is the practical "how do I use it" doc;
see [ADR-0040](architecture-decisions/ADR-0040-ai-model-routing.md) for why
it's built this way.

## The core rule

**Nobody outside `packages/ai-router/src/openai.ts` writes a literal model
id.** Screens, gateways, and packages ask for a **task**; the router decides
the tier, and the tier resolves to a concrete model. If you're adding a new
AI call site and you find yourself typing `'gpt-...'` anywhere outside that
one file, stop — add (or reuse) a task in `types.ts` instead.

## Tiers

| Tier        | Default model            | Price (in/out per 1M tokens) | Used for                                       |
| ----------- | ------------------------ | ---------------------------- | ---------------------------------------------- |
| SPECIALIZED | `text-embedding-3-small` | $0.02 / —                    | Embeddings only (never on the chat ladder)     |
| ECONOMY     | `gpt-5.6-luna`           | $0.20 / $1.20                | High-volume, structured, validated downstream  |
| STANDARD    | `gpt-5.6-terra`          | $2.00 / $12.00               | Retrieval-grounded answers, complex generation |
| ADVANCED    | `gpt-5.6-sol`            | $5.00 / $30.00               | Deep reasoning; never silently downgraded      |

These identifiers are code-verified defaults, not a claim of access by a
particular account. Re-verify with `pnpm --filter @avidia/worker verify-models`
before deployment and whenever OpenAI changes the account catalog.

## Task -> tier mapping

| Task                            | Tier                                                 | Notes                                                                                           |
| ------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `EMBEDDING`                     | SPECIALIZED                                          | Bypasses the tier ladder; no fallback (different embedding models produce incomparable vectors) |
| `CONCEPT_EXTRACTION`            | ECONOMY                                              | Live: `packages/knowledge/src/gateway.ts`                                                       |
| `QUESTION_GENERATION_ROUTINE`   | ECONOMY                                              | Live: `packages/assessment/src/gateway.ts`                                                      |
| `BASIC_EXPLANATION`             | ECONOMY                                              |                                                                                                 |
| `QUESTION_GENERATION_COMPLEX`   | STANDARD                                             |                                                                                                 |
| `RAG_ANSWER`                    | STANDARD                                             |                                                                                                 |
| `SIMULATION_DIALOGUE`           | STANDARD                                             |                                                                                                 |
| `CASE_STUDY_GENERATION`         | STANDARD (HIGH complexity -> ADVANCED)               | Only chat task whose tier depends on `complexity`                                               |
| `QUESTION_REPAIR`               | ECONOMY by default; floors at `requirements.minTier` | "Same tier, escalate only if necessary"                                                         |
| `DEEP_TUTORING`                 | ADVANCED                                             | No fallback — nothing above ADVANCED                                                            |
| `CLINICAL_REASONING_EVALUATION` | ADVANCED                                             | No fallback                                                                                     |
| `SIMULATION_CASE_GENERATION`    | ADVANCED                                             | No fallback                                                                                     |

Fallback for every other task is always the next tier **up** — never a
downgrade — unless `requirements.allowFallback: false` is set.

## Calling it

Routing decision only (no I/O):

```ts
import { routeAiTask } from '@avidia/ai-router';

const route = routeAiTask({ task: 'RAG_ANSWER', complexity: 'MEDIUM' });
// { provider: 'openai', model: 'gpt-5.6-terra', tier: 'STANDARD',
//   fallback: { provider: 'openai', model: 'gpt-5.6-sol', tier: 'ADVANCED' } }
```

Routing + bounded retry + safe fallback + observability, for a new call site:

```ts
import { executeAiTask, AiAttemptOutcome } from '@avidia/ai-router';

const result = await executeAiTask({
  request: { task: 'RAG_ANSWER', complexity: 'MEDIUM' },
  attempt: async (choice): Promise<AiAttemptOutcome<string>> => {
    // choice.model / choice.provider / choice.tier — call the provider here.
    // Classify the outcome: { ok: true, value, usage? } or
    // { ok: false, reason: 'http_429' | 'http_5xx' | 'timeout' |
    //   'network_error' | 'quota_exceeded' | 'invalid_response' | 'other',
    //   retryableSameModel: boolean, detail: string }.
  },
});
// result.value, result.choice (which model actually served it), result.usedFallback
```

`executeAiTask` throws `AiTaskFailedError` after primary AND fallback are
exhausted. `.message` is always the generic, student-safe
"This AI task could not be completed right now. Please try again shortly."
— never show `.detail` (the real reason) to a student; log it instead.

## The two legacy gateways (concept extraction, routine question generation)

`packages/knowledge/src/gateway.ts` and `packages/assessment/src/gateway.ts`
predate the router and keep their own proven bounded-retry HTTP loop rather
than being rewritten onto `executeAiTask` (see ADR-0040 section 4 for why).
What changed for them:

- Their default model is resolved through `routeAiTask()` using the supplied
  server environment; central `AI_MODEL_ECONOMY` overrides reach live callers.
- Each call emits one `AiRouterEvent` (success or failure) via
  `emitAiRouterEvent`, so they show up in the same telemetry stream as
  router-native call sites.
- Their pre-router env vars (`CONCEPT_MODEL`, `QUESTION_MODEL`,
  `CONCEPT_PROVIDER`, `QUESTION_PROVIDER`) are unchanged and still take
  precedence over the router default.

`packages/rag/src/embedding.ts` is untouched — embeddings deliberately keep
their pre-router `EMBEDDING_PROVIDER`/`OPENAI_API_KEY` contract (a different
embedding model would produce vectors incomparable to what's already
stored).

## Configuration (server-only)

Read from `process.env` (or an equivalent server env map) by the worker/
backend only. **Never** prefix any of these `EXPO_PUBLIC_` — that would ship
them to the client bundle.

| Variable                                                       | Default                  | Purpose                                                                                                       |
| -------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                                               | — (required)             | Provider credential                                                                                           |
| `AI_PROVIDER`                                                  | `openai`                 | Selects the provider catalog                                                                                  |
| `AI_MODEL_ECONOMY` / `AI_MODEL_STANDARD` / `AI_MODEL_ADVANCED` | tier defaults above      | Per-tier override, independent of each other                                                                  |
| `AI_MODEL_EMBEDDING`                                           | `text-embedding-3-small` | Embedding model override (router-native call sites only — `packages/rag` doesn't read this)                   |
| `CONCEPT_MODEL`, `QUESTION_MODEL`                              | router ECONOMY default   | Legacy per-gateway override, still honored (takes precedence over `AI_MODEL_ECONOMY` at those two call sites) |
| `CONCEPT_PROVIDER`, `QUESTION_PROVIDER`, `EMBEDDING_PROVIDER`  | `openai`                 | Legacy provider selection (`scripted`/`hashing` for keyless dev/test) — unchanged by this work                |

## Never routed to an LLM

Question scoring, dosage arithmetic (`packages/assessment/src/score.ts`),
mastery calculation, spaced repetition, study priority
(`packages/mastery`), planner scheduling (`packages/planner`), analytics
math (`packages/analytics`), billing entitlement
(`packages/entitlements`), and M11 simulation state transitions/scoring
(`packages/simulation`) must never import `@avidia/ai-router` or call
`fetch`. This is enforced by a static scan, not just convention:

```
pnpm test:ai-boundary
```

Run this whenever you touch any of those packages; it's a pure source scan
(no network, no secrets) and fails loudly with the exact file and pattern if
the boundary is ever crossed.

## Observability

Every `executeAiTask` attempt (and every legacy-gateway call) emits an
`AiRouterEvent`: `task`, `complexity`, `tier`, `provider`, `model`,
`latencyMs`, `tokens` (optional), `estimatedCostUsd` (optional, best-effort
from `packages/ai-router/src/pricing.ts`), `retryCount`, `usedFallback`,
`success`, `failureReason` (on failure only — a short code like `http_429`,
never a raw provider message). **No field ever carries a prompt, a course
excerpt, or a response body** — set `setAiRouterEventSink()` to route these
into your logging backend; the default sink prints one JSON line per event
to stdout.

## Verifying model ids against the real account

Documentation can lag what's actually enabled on an account. To check the
router's hard-coded ids against reality:

```
pnpm --filter @avidia/worker verify-models
```

Requires `OPENAI_API_KEY` in the environment; skips cleanly (exit 0) if
unset. In CI, run it via the **Verify AI Model Routing IDs** workflow
(`.github/workflows/verify-ai-models.yml`, manual `workflow_dispatch`) —
it reuses the same `OPENAI_API_KEY` repository secret the worker workflow
already has; the key is read only inside the Action runner and is never
logged.

## Adding a new AI call site

1. Add the task to `AI_TASKS` in `packages/ai-router/src/types.ts`.
2. Add its tier (or complexity-sensitive rule) to `FIXED_TIER` /
   `baseTierForTask` in `packages/ai-router/src/tiers.ts`. TypeScript will
   flag a missing mapping at compile time (`tiers.ts`'s exhaustiveness
   check).
3. Call `executeAiTask` at the call site, classifying provider responses
   into `AiAttemptOutcome`. Do not write a model id.
4. If the task lives in a package that must never reach an LLM, don't do
   this at all — check the never-route list above first.
