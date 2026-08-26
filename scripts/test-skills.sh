#!/usr/bin/env bash
#
# test-skills.sh — run the Skill #1/#2/#3 integration test suite.
#
# Usage:
#   scripts/test-skills.sh                # run all skill integration tests
#   scripts/test-skills.sh 1              # run only "SKILL #1" tests
#   scripts/test-skills.sh 2              # run only "SKILL #2" tests
#   scripts/test-skills.sh 3              # run only "SKILL #3" tests
#   scripts/test-skills.sh e2e            # run only the end-to-end tests
#
# Requires dependencies to be installed (`pnpm install` from the repo root).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_FILE="packages/assessment/src/__tests__/skill-integration.test.ts"

usage() {
  echo "Usage: $0 [1|2|3|e2e|all]" >&2
  exit 1
}

SKILL="${1:-all}"

case "$SKILL" in
  1)
    PATTERN='SKILL #1'
    ;;
  2)
    PATTERN='SKILL #2'
    ;;
  3)
    PATTERN='SKILL #3'
    ;;
  e2e|end-to-end)
    PATTERN='END-TO-END'
    ;;
  all)
    PATTERN=''
    ;;
  *)
    usage
    ;;
esac

cd "$REPO_ROOT"

if [ -n "$PATTERN" ]; then
  echo "Running skill integration tests matching: $PATTERN"
  pnpm --filter @avidia/assessment exec jest "$TEST_FILE" -t "$PATTERN"
else
  echo "Running all skill integration tests"
  pnpm --filter @avidia/assessment exec jest "$TEST_FILE"
fi
