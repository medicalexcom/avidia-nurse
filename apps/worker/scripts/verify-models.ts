/**
 * Verifies the AI router's hard-coded OpenAI model ids (packages/ai-router/
 * src/openai.ts) against the OpenAI account actually configured for this
 * deployment — spec section 3: "Use official current OpenAI API model
 * availability and verify against the configured account."
 *
 * Calls GET https://api.openai.com/v1/models with the OPENAI_API_KEY already
 * present in the environment (a GitHub Actions secret in CI; never printed,
 * never returned to the caller — only pass/fail per model id is reported).
 *
 * Usage:  pnpm --filter @avidia/worker verify-models
 * Exits 0 with SKIPPED when OPENAI_API_KEY is not set, so this can run
 * unconditionally in CI and only activates where the secret exists (mirrors
 * scripts/authz-check.mjs's skip pattern at the repo root).
 * Exits 1 if any router model id is not present in the account's model list,
 * or if the OpenAI API call itself fails (bad key, network, etc).
 */
import { allOpenAiModelIds } from '@avidia/ai-router';

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log('SKIPPED: verify-models requires OPENAI_API_KEY.');
    return;
  }

  const response = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    console.log(`FAIL  OpenAI /v1/models request failed with status ${response.status}.`);
    process.exitCode = 1;
    return;
  }

  const payload = (await response.json()) as { data?: { id: string }[] };
  const availableIds = new Set((payload.data ?? []).map((model) => model.id));

  let failures = 0;
  for (const modelId of allOpenAiModelIds()) {
    const ok = availableIds.has(modelId);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${modelId}${ok ? '' : ' — not available on this account'}`);
    if (!ok) failures += 1;
  }

  if (failures > 0) {
    console.log(
      `\n${failures} router model id(s) are not available on the configured OpenAI account. ` +
        'Update packages/ai-router/src/openai.ts (or set an AI_MODEL_* env override — see ' +
        'packages/ai-router/src/config.ts) before relying on routing for the affected tier(s).'
    );
    process.exitCode = 1;
    return;
  }
  console.log(`\nAll ${allOpenAiModelIds().length} router model id(s) are available on the configured account.`);
}

main().catch((error) => {
  console.log(`FAIL  verify-models crashed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
