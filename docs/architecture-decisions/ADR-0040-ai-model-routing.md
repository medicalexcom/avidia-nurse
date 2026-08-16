# ADR-0040: Task-aware AI model routing (v1)

- **Status:** Accepted
- **Date:** 2026-08-15
- **Milestone:** AI Model Routing v1 (cross-cutting infrastructure — explicitly not M16; does not modify M8 mastery logic or M11's deterministic simulation runtime)

## Context

Every AI call site in the product (M5 embeddings, M6 concept extraction, M7
question generation, and near-future work: RAG answers, tutoring, clinical
reasoning evaluation, simulation authoring) picked its own model id and its
own ad hoc retry logic, with no shared vocabulary for "how capable does this
task need to be" versus "which vendor happens to implement that today." Two
concrete problems followed from that: model ids were hard-coded per package
(`packages/knowledge/src/gateway.ts`'s `gpt-4o-mini`,
`packages/assessment/src/gateway.ts`'s `gpt-4o-mini`), so upgrading a model
generation meant hunting through call sites instead of changing one file;
and there was no shared observability format, so cost/latency/failure data
for one task told you nothing comparable about another.

Separately, model identifiers must not be invented from product-family names
or treated as globally available. The defaults are real API identifiers and
the verification command checks them against the configured account before
deployment. `text-embedding-3-small` remains pinned because changing it would
make existing stored vectors incomparable.

Explicit constraints for this change: it must not modify M8 (`packages/mastery`)
mastery-calculation logic or M11's (`packages/simulation`) deterministic
simulation runtime — those packages remain, and must provably remain,
unreachable from any LLM call.

## Decision

### 1. Tiers, not providers or model names, are the unit of routing

`packages/ai-router` introduces four tiers (`packages/ai-router/src/types.ts`):
`SPECIALIZED` (embeddings — not on the chat capability ladder),
`ECONOMY`, `STANDARD`, `ADVANCED` (chat/reasoning, ranked by capability and
cost). A task asks for a **tier**, never a model id or a provider name — the
one file allowed to know a literal OpenAI model id is
`packages/ai-router/src/openai.ts`. Today every tier resolves to an OpenAI
model; adding a second provider is a new entry in
`packages/ai-router/src/config.ts`'s `PROVIDERS` map, not a call-site rewrite.

### 2. Fixed task -> tier mapping, with two tasks needing runtime context

`packages/ai-router/src/tiers.ts` hard-codes the tier for nine of eleven
chat tasks (`CONCEPT_EXTRACTION` / `QUESTION_GENERATION_ROUTINE` /
`BASIC_EXPLANATION` -> ECONOMY; `QUESTION_GENERATION_COMPLEX` / `RAG_ANSWER`
/ `SIMULATION_DIALOGUE` -> STANDARD; `DEEP_TUTORING` /
`CLINICAL_REASONING_EVALUATION` / `SIMULATION_CASE_GENERATION` -> ADVANCED).
`CASE_STUDY_GENERATION` reads `complexity` (STANDARD unless `HIGH`, then
ADVANCED). `QUESTION_REPAIR` defaults to ECONOMY but a caller can float it to
the tier of the question being repaired via `requirements.minTier` — "same
tier, escalate only if necessary," never downgraded below what produced the
original content. `EMBEDDING` is SPECIALIZED and resolved directly from the
provider catalog's `embeddingModel`, bypassing the tier ladder entirely.

### 3. Fallback always escalates, never downgrades

`routeAiTask()` (`packages/ai-router/src/router.ts`) returns a `fallback`
alongside the primary choice: the next tier **up**, or `null` when already
at ADVANCED, when the task disallows fallback
(`requirements.allowFallback: false`), or for EMBEDDING (a different
embedding model produces incomparable vectors — ADR-0012). A cheap task
escalating to a pricier-but-capable model on failure is always safe; the
reverse — silently downgrading a clinical-authoring request to a model that
can't satisfy the required reasoning quality — is never allowed, per this
task's explicit instruction.

### 4. `executeAiTask()` is the reusable retry/fallback/observability wrapper — new call sites use it; the two existing high-volume gateways keep their own proven retry loop for now

`packages/ai-router/src/execute.ts` provides bounded retry with backoff
(429/5xx/timeout/network-error retry the same model; `quota_exceeded` and
schema-invalid responses escalate to the fallback tier without retrying the
same model), a student-safe `AiTaskFailedError` (generic `.message`, real
`.detail` for logs only), and one observability event per attempt. Any new
AI call site (RAG answers, tutoring, simulation authoring, ...) should call
this rather than reimplementing retry logic.

The two call sites that predate the router — `packages/knowledge/src/gateway.ts`
(concept extraction) and `packages/assessment/src/gateway.ts` (routine
question generation) — already had their own well-tested bounded-retry
logic (3 attempts, 429/5xx backoff, immediate fail on other 4xx) with
~450 lines of passing tests asserting its exact behavior. This migration
changes what model id they use (sourced from `OPENAI_CHAT_MODELS.ECONOMY`
in `openai.ts`, not hard-coded locally — satisfying "do not hard-code model
names") and adds one observability event per call
(`emitAiRouterEvent`, spec section 8), but deliberately leaves their
internal HTTP retry loop and error types as-is rather than rewriting them
onto `executeAiTask`'s per-attempt fallback escalation. Rewriting them would
change externally-visible behavior (attempt counts, thrown error messages)
that dozens of existing tests assert on, for marginal benefit at these two
specific call sites — both already fixed at ECONOMY tier with a low-risk
failure mode (a failed extraction/generation round is retried by the
next worker poll, not surfaced to a student in real time). Migrating them
onto `executeAiTask` for full fallback-tier escalation is a scoped,
low-risk fast-follow, not required for this task's "STOP after router
completion" instruction. `packages/rag/src/embedding.ts` is explicitly
**not** touched at all (spec section 3: "EMBEDDING -> preserve existing
config") — it keeps its own `EMBEDDING_PROVIDER`/`OPENAI_API_KEY` contract.

### 5. Env var compatibility: old vars still work, new vars are additive

`CONCEPT_MODEL`, `QUESTION_MODEL`, `CONCEPT_PROVIDER`, `QUESTION_PROVIDER`,
`EMBEDDING_PROVIDER` keep working exactly as before — read at the gateway
call site, taking precedence over the router's own default for that
gateway's fixed tier. New variables `AI_PROVIDER` /
`AI_MODEL_ECONOMY` / `AI_MODEL_STANDARD` / `AI_MODEL_ADVANCED` /
`AI_MODEL_EMBEDDING` (`packages/ai-router/src/config.ts`) override the
router's per-tier defaults for every task at once, additively (setting one
tier's override never resets the others). No founder action is required by
this change; the new variables are optional.

### 6. The never-route boundary is enforced by a static source scan, not just a runtime test

Question scoring, dosage arithmetic (`packages/assessment/src/score.ts`),
mastery calculation, spaced repetition, study priority (`packages/mastery`),
planner scheduling (`packages/planner`), analytics math
(`packages/analytics`), billing entitlement (`packages/entitlements`), and
M11 simulation state transitions/scoring (`packages/simulation`) must never
reach an LLM. `scripts/ai-boundary-check.mjs` (wired as the root
`test:ai-boundary` script, mirroring the `scripts/authz-check.mjs`
precedent) scans every production source file under those packages for an
`@avidia/ai-router` import, a `fetch(...)` call, or a literal AI-provider
reference, and fails the build if any is found. A static scan proves the
stronger claim — the capability is unreachable from the source — rather
than merely "no test happened to exercise it."

### 7. Model-id currency is re-verifiable against the live account, not just documentation

`apps/worker/scripts/verify-models.ts` (`pnpm --filter @avidia/worker
verify-models`) calls OpenAI's own `GET /v1/models` with the already
configured `OPENAI_API_KEY` and checks every id `packages/ai-router/src/openai.ts`
hands out is actually available on that account — never printing or
returning the key itself. Wired as a manual
`.github/workflows/verify-ai-models.yml` `workflow_dispatch` job using the
same repository secret the worker already has. Re-run this whenever OpenAI
ships a new model generation.

## Consequences

- Upgrading a model tier (or adding a provider) is a one-file change in
  `packages/ai-router`, not a hunt across every package that calls an LLM.
- Every new AI call site gets bounded retry, safe fallback, and consistent
  observability for free by calling `executeAiTask`; the two legacy call
  sites are migrated on model-id sourcing and observability now, with full
  retry-wrapper migration explicitly deferred and documented rather than
  silently skipped.
- `packages/mastery`, `packages/simulation`, `packages/planner`,
  `packages/analytics`, `packages/entitlements`, and question
  scoring/dosage math have an automated, CI-enforceable proof (not just a
  convention) that they can never silently grow an LLM dependency.
- Observability events never carry prompt, response, or course content —
  only task/tier/model/latency/tokens/cost/outcome — so operational
  telemetry cannot leak student or course data.
- The exact OpenAI model ids in `openai.ts` will go stale again eventually;
  `verify-models`/`verify-ai-models.yml` gives a repeatable way to catch
  that against the real account instead of re-trusting documentation
  indefinitely.
