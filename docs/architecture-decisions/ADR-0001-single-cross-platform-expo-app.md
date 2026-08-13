# ADR-0001: Single cross-platform student app (Expo / React Native / Expo Web)

- **Status:** Accepted
- **Date:** 2026-08-12
- **Milestone:** M0

## Context

Avidia Nurse must serve students on iOS, Android, and web/desktop. Maintaining separate React
Native and Next.js student applications would double UI work, split testing effort, and let the
two experiences drift apart — unacceptable for a small team with a nontechnical founder.

## Decision

One student application built with Expo (React Native + Expo Web + TypeScript) targets all three
platforms from a single codebase. Desktop/web is a first-class target: screens use responsive
patterns (`useWindowDimensions`, breakpoint-conditional styles, and `Platform`/`.web.tsx` variants
where needed) rather than a mobile layout stretched to desktop. `apps/student/src/screens/HomeScreen.tsx`
establishes this pattern from the first screen.

A separate faculty/admin web application may be added later only if institutional requirements
justify it; it would live under `apps/` alongside the student app.

## Consequences

- One codebase, one test suite, one release pipeline for the student experience.
- Web-specific polish (keyboard shortcuts, hover states, multi-column dashboards) is implemented
  inside the same component tree, guarded by platform/width checks.
- Some heavy web-only libraries are unavailable; we accept this constraint in exchange for
  maintainability.
