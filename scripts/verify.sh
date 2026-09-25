#!/usr/bin/env bash
# Reproduce the CI matrix locally, in the same order, with the same
# toolchain expectations. One command instead of remembering six.
#
# Usage:
#   scripts/verify.sh              # everything
#   scripts/verify.sh --fast       # skip the E2E suites (no daemon needed)
#   scripts/verify.sh --no-e2e     # alias of --fast
#
# Requirements: zig 0.14.1 on PATH, Node >= 20, and `npm ci` already run in
# src/sdk/ts. This is the same contract as the workflows, so a green run
# here means a green CI run (modulo the OS matrix, which only CI can do).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

RUN_E2E=1
for arg in "$@"; do
  case "$arg" in
    --fast|--no-e2e) RUN_E2E=0 ;;
    -h|--help)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

FAILURES=0
STEP=0

step() {
  STEP=$((STEP + 1))
  printf '\n\033[1m[%d/%d] %s\033[0m\n' "$STEP" "$TOTAL_STEPS" "$1"
}

ok()   { printf '\033[32m  ok\033[0m %s\n' "$1"; }
bad()  { printf '\033[31m  FAIL\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

# Run a command, report pass/fail, never abort the script: a full run should
# report every broken step, not just the first.
run() {
  local label="$1"; shift
  if "$@" >/tmp/verify-last.log 2>&1; then
    ok "$label"
  else
    bad "$label"
    sed 's/^/      /' /tmp/verify-last.log | tail -25
  fi
}

if [ "$RUN_E2E" -eq 1 ]; then
  TOTAL_STEPS=7
else
  TOTAL_STEPS=5
fi

command -v zig >/dev/null 2>&1 || { echo "zig not found on PATH (need 0.14.1)" >&2; exit 1; }

step "zig version"
ZIG_VER="$(zig version)"
echo "  zig $ZIG_VER"
if [ "$ZIG_VER" != "0.14.1" ]; then
  bad "expected zig 0.14.1 (CI pins it; macos-15/windows-2022 are pinned for it), got $ZIG_VER"
fi

step "zig fmt --check"
run "zig fmt --check src/ build.zig" zig fmt --check src/ build.zig

step "zig build test"
run "zig build test" zig build test

step "TypeScript SDK: tsc --noEmit + vitest"
run "npm test (src/sdk/ts)" npm --prefix src/sdk/ts test

step "scripts typecheck"
TSC="src/sdk/ts/node_modules/.bin/tsc"
if [ -x "$TSC" ]; then
  run "tsc -p scripts/tsconfig.json" "$TSC" -p scripts/tsconfig.json
else
  bad "typescript compiler not found at $TSC (run: npm ci --prefix src/sdk/ts)"
fi

if [ "$RUN_E2E" -eq 1 ]; then
  step "zig build (daemon + N-API addon, ReleaseSafe)"
  # CI uses ReleaseSafe, not the Debug default, so a local run must too:
  # measuring a different binary than CI is how benches drift.
  run "zig build -Doptimize=ReleaseSafe" zig build -Doptimize=ReleaseSafe

  step "E2E suites"
  run "run-e2e (10 suites)" npm --prefix scripts run test:e2e
fi

printf '\n'
if [ "$FAILURES" -eq 0 ]; then
  printf '\033[32mverify.sh: all checks passed\033[0m\n'
  exit 0
fi
printf '\033[31mverify.sh: %d check(s) failed\033[0m\n' "$FAILURES"
exit 1
