# Avidia Nurse

Avidia Nurse is a commercial adaptive nursing-education platform for ABSN/BSN students. One
cross-platform student application (iOS, Android, and web/desktop) delivers course-material-grounded
study tools, persistent mastery tracking, spaced repetition, and stateful patient simulations —
powered by AI but never dependent on any single AI provider.

**Current milestone: M0 — Repository Bootstrap.** Only the project skeleton exists. There is no
backend, authentication, AI integration, or study functionality yet.

## Repository structure

```
avidia-nurse/
├── apps/
│   └── student/            # The single cross-platform student app (Expo / React Native / Expo Web)
│       ├── App.tsx         # Root component
│       ├── app.json        # Expo configuration (iOS/Android/web targets)
│       └── src/
│           ├── config/     # Validated environment configuration
│           ├── screens/    # Screens (responsive: one tree for mobile + desktop web)
│           └── components/ # Shared UI components
├── packages/
│   └── core/               # Platform-agnostic domain logic (no React, no LLM dependencies).
│                           # The adaptive learning engine will live here so it exists
│                           # independently of any AI provider.
├── docs/
│   ├── architecture-decisions/  # ADRs — why the architecture is the way it is
│   └── worklogs/                # Per-milestone worklogs (what was done and why)
└── .github/workflows/           # CI: format, lint, typecheck, test, web build
```

## Prerequisites

- Node.js 20 or newer (22 recommended)
- npm 10+
- For iOS/Android device testing: the [Expo Go](https://expo.dev/go) app, or Xcode / Android Studio
  for simulators

## Getting started

```bash
npm install                # install all workspace dependencies
cp .env.example .env       # optional: local environment overrides (never commit .env)

npm run web                # start the app in a web browser
npm start                  # start Metro; press i for iOS, a for Android, w for web
```

## Quality checks

```bash
npm run lint               # ESLint across the whole repo
npm run format:check       # Prettier formatting check (format with: npm run format)
npm run typecheck          # TypeScript, all workspaces
npm test                   # Jest, all workspaces
npm run build:web          # production web export (apps/student/dist)
```

All of these run in CI on every push and pull request.

## Environment variables and secrets

Client configuration uses Expo's `EXPO_PUBLIC_*` convention and is validated at startup with a
schema (`packages/core/src/env.ts`). See `.env.example`.

**Never put secrets in this repository or in any `EXPO_PUBLIC_*` variable.** Anything prefixed
`EXPO_PUBLIC_` is embedded in the client bundle and visible to every user. AI provider keys,
database service keys, and other secrets will live only in backend environment configuration
introduced in later milestones.

## Documentation

- Architecture decisions: `docs/architecture-decisions/`
- Milestone worklogs: `docs/worklogs/`
