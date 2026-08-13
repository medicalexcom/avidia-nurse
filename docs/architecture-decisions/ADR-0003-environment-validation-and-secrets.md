# ADR-0003: Schema-validated environment configuration; no secrets in the client

- **Status:** Accepted
- **Date:** 2026-08-12
- **Milestone:** M0

## Context

Misconfigured environments cause silent, hard-to-diagnose failures, and client bundles are public:
anything shipped in them can be extracted by any user. The platform will eventually hold AI
provider keys and database service credentials that must never reach the client.

## Decision

1. All client-visible configuration uses Expo's `EXPO_PUBLIC_*` convention and is validated at app
   startup against a Zod schema (`packages/config/src/env.ts`, applied in
   `apps/app/src/config/env.ts`). Invalid configuration fails fast with a readable error.
2. Only non-secret values may ever use the `EXPO_PUBLIC_` prefix. Secrets (AI provider keys,
   service-role keys, signing keys) will live exclusively in backend environment configuration
   introduced with the backend milestone, validated by an equivalent server-side schema.
3. `.env` files are git-ignored; `.env.example` documents every variable and the secrecy rules.

## Consequences

- New configuration requires a schema change, which doubles as documentation and review surface.
- The same validation utility will be reused server-side, keeping one pattern across the stack.
- CI and code review can mechanically check that no `EXPO_PUBLIC_` variable holds secret material.
