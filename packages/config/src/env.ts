import { z } from 'zod';

/**
 * Client-safe environment configuration.
 *
 * IMPORTANT: Only variables prefixed with EXPO_PUBLIC_ are ever available in
 * the client bundle, and ONLY non-secret values may use that prefix.
 * Server/API secrets (AI provider keys, service-role keys, etc.) must live
 * exclusively in backend environments introduced in later milestones and must
 * never appear here.
 */

export const APP_ENVIRONMENTS = ['development', 'preview', 'production'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

const httpUrl = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'must be a valid http(s) URL' }
  );

export const clientEnvSchema = z.object({
  /** Which deployment environment the app believes it is running in. */
  EXPO_PUBLIC_APP_ENV: z.enum(APP_ENVIRONMENTS).default('development'),
  /** Base URL of the Avidia backend API. Optional until the backend exists (M2+). */
  EXPO_PUBLIC_API_BASE_URL: httpUrl.optional(),
  /** Public URL of the deployed web app (deep links, share links). Optional in M0. */
  EXPO_PUBLIC_WEB_APP_URL: httpUrl.optional(),
  /** Public (non-secret) analytics write key. Optional until analytics lands. */
  EXPO_PUBLIC_ANALYTICS_KEY: z.string().min(1).optional(),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validate raw environment variables (e.g. process.env) against the client
 * schema. Throws EnvValidationError with a readable message on failure so the
 * app fails fast at startup instead of misbehaving later.
 */
export function validateClientEnv(raw: Record<string, string | undefined>): ClientEnv {
  const result = clientEnvSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`
    );
    throw new EnvValidationError(issues);
  }
  return result.data;
}
