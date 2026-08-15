#!/usr/bin/env node
/**
 * AI routing boundary check (AI model routing v1, spec section 4):
 *
 *   "NEVER ROUTE THESE TO AN LLM — question scoring, dosage arithmetic,
 *    mastery calculation, spaced repetition, study priority, planner
 *    scheduling, analytics math, billing entitlement, M11 simulation state
 *    transitions, M11 simulation scoring. Add tests proving this boundary."
 *
 * This is a static source scan, not a runtime test, because the boundary
 * being proven is "this code never imports an AI/network capability at
 * all" — the strongest version of that claim is that the capability is
 * unreachable from the source, not merely unexercised by whatever test
 * cases exist today. Mirrors the precedent in scripts/authz-check.mjs
 * (a standalone Node check wired into a root package.json script) rather
 * than a package-local Jest test, because the boundary spans several
 * packages that must never depend on @avidia/ai-router or fetch.
 *
 * Scans, PRODUCTION SOURCE ONLY (*.test.ts and *.fixture.ts are excluded —
 * this proves what ships, not what a future test mock might reference):
 *   packages/mastery/src        — mastery calculation, spaced repetition,
 *                                  study priority (M8)
 *   packages/planner/src        — planner scheduling (M9)
 *   packages/analytics/src      — analytics math (M12)
 *   packages/entitlements/src   — billing entitlement (M14)
 *   packages/simulation/src     — M11 simulation state transitions
 *                                  (engine.ts) and scoring (score.ts) —
 *                                  the whole package, since "the LLM is
 *                                  never the authoritative simulation
 *                                  engine" is a package-wide invariant
 *   packages/assessment/src/score.ts — question scoring, dosage arithmetic
 *                                  (assessment/gateway.ts is EXEMPT: it is
 *                                  the legitimate M7 question-generation
 *                                  AI call site, migrated onto the router)
 *
 * Forbidden in every scanned file:
 *   - any import of @avidia/ai-router (routeAiTask / executeAiTask / etc.)
 *   - a call to fetch(...) (the only transport AI providers are called
 *     through in this repo — see the gateway.ts files under packages)
 *   - a literal reference to an AI provider hostname or SDK name (openai,
 *     anthropic, api.openai.com, ...)
 *
 * Usage:  node scripts/ai-boundary-check.mjs
 * Exits 1 (and prints every violation) if any forbidden pattern is found;
 * exits 0 otherwise. Requires no environment/secrets — pure static scan.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

const SCAN_TARGETS = [
  { label: 'mastery calculation, spaced repetition, study priority (M8)', path: 'packages/mastery/src' },
  { label: 'planner scheduling (M9)', path: 'packages/planner/src' },
  { label: 'analytics math (M12)', path: 'packages/analytics/src' },
  { label: 'billing entitlement (M14)', path: 'packages/entitlements/src' },
  {
    label: 'M11 simulation state transitions + scoring (deterministic runtime — never modified by the AI-routing task)',
    path: 'packages/simulation/src',
  },
  { label: 'question scoring, dosage arithmetic (M7)', path: 'packages/assessment/src/score.ts' },
];

const FORBIDDEN_PATTERNS = [
  { name: '@avidia/ai-router import', re: /@avidia\/ai-router/ },
  { name: 'fetch(...) call', re: /\bfetch\s*\(/ },
  { name: 'AI provider reference', re: /\bopenai\b|\banthropic\b|api\.openai\.com/i },
];

function listSourceFiles(path) {
  const abs = join(ROOT, path);
  const info = statSync(abs);
  if (info.isFile()) {
    return [abs];
  }
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = join(abs, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(relative(ROOT, entryPath)));
      continue;
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
    if (entry.name.endsWith('.fixture.ts')) continue;
    out.push(entryPath);
  }
  return out;
}

let violations = 0;
let filesScanned = 0;

for (const target of SCAN_TARGETS) {
  const files = listSourceFiles(target.path);
  for (const file of files) {
    filesScanned += 1;
    const content = readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.re.test(content)) {
        violations += 1;
        console.log(
          `FAIL  ${relative(ROOT, file)} — ${pattern.name} found (boundary: ${target.label})`
        );
      }
    }
  }
}

if (violations === 0) {
  console.log(
    `PASS  ${filesScanned} production source file(s) across ${SCAN_TARGETS.length} boundaries contain no AI-router import, fetch() call, or AI provider reference.`
  );
  process.exit(0);
} else {
  console.log(`\n${violations} violation(s) found. These paths must never call an LLM (spec section 4).`);
  process.exit(1);
}
