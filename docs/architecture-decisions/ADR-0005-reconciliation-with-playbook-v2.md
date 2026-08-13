# ADR-0005: Post-M0 reconciliation with the AI Build Implementation Playbook v2

- **Status:** Accepted (supersedes parts of ADR-0002; resolves ADR-0004)
- **Date:** 2026-08-12
- **Milestone:** M0 (reconciliation audit)

## Context

M0 was implemented before the three governing documents were available (see ADR-0004). The
documents have now been provided and audited against the repository. The Playbook §4 defines the
repository layout contract, §5 the environment/secret conventions, and §26 the CI requirements.

## Differences found and corrections applied

1. **Workspace tooling.** Playbook §4 specifies `pnpm-workspace.yaml` + `turbo.json`. ADR-0002 had
   chosen plain npm workspaces. Corrected: migrated to pnpm workspaces + Turborepo
   (`node-linker=hoisted` for Expo/Metro compatibility). ADR-0002's package-boundary reasoning
   still stands; its tooling choice is superseded.
2. **App directory.** Playbook layout names the Expo app `apps/app`. Renamed `apps/student` →
   `apps/app` (package `@avidia/app`).
3. **Config package.** Our `packages/core` contained only environment/configuration logic, which
   the Playbook locates in `packages/config`. Renamed to `packages/config` (`@avidia/config`).
   The Playbook's `domain`, `adaptive-engine`, `ai-gateway`, `content`, `retrieval`, `ui`, and
   `telemetry` packages are deliberately NOT created yet: empty placeholder packages would be
   structurally misleading. Each is created in the milestone that gives it real content.
4. **Environment variables.** Renamed `EXPO_PUBLIC_API_URL` → `EXPO_PUBLIC_API_BASE_URL` and added
   optional `EXPO_PUBLIC_WEB_APP_URL` and `EXPO_PUBLIC_ANALYTICS_KEY` to match Playbook §5.
   `EXPO_PUBLIC_APP_ENV` is retained as an addition (used by the Pages preview deployment); it is
   non-secret and does not conflict with the contract.
5. **Docs layout.** Added `docs/product/` (now containing the three authoritative documents),
   `docs/api/`, `docs/prompts/`, and `docs/runbooks/` per Playbook §4.
6. **Secret scanning.** Added a Gitleaks job to CI per Playbook §5/§26.

## Deliberately deferred (per milestone plan, not drift)

`services/worker`, `supabase/{migrations,seed,functions}`, auth, Supabase implementation, AI
gateway, adaptive engine, UI design-system package, telemetry. Each arrives with its milestone
(M1–M15). Premature implementation of these is itself classified as drift by the audit rules.

## Consequences

- The repository now matches the Playbook layout for everything that exists at M0.
- Future workspaces are added with `pnpm-workspace.yaml` already in place; Turborepo caches
  lint/typecheck/test/build across packages as the workspace count grows.
- `pnpm` is the only supported package manager (`packageManager` field is set; npm lockfile
  removed).
