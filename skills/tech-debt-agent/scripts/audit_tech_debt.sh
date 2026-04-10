#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:-.}"
OUT_FILE="${2:-$REPO_ROOT/TECH_DEBT_REPORT.md}"

cd "$REPO_ROOT"

count_matches() {
  local cmd="$1"
  bash -lc "$cmd" 2>/dev/null | wc -l | tr -d ' '
}

TODO_COUNT=$(count_matches "rg -n 'TODO|FIXME|HACK|XXX' src public --glob '!**/*.min.*' || true")
ANY_COUNT=$(count_matches "rg -n '\\bany\\b' src --glob '*.ts' || true")
CONSOLE_COUNT=$(count_matches "rg -n 'console\\.(log|error|warn|debug)' src public || true")
TS_IGNORE_COUNT=$(count_matches "rg -n '@ts-ignore|@ts-expect-error' src || true")

TEST_FILES=$(count_matches "rg --files src | rg '\\.test\\.ts$' || true")
SOURCE_FILES=$(count_matches "rg --files src | rg '\\.ts$' || true")

{
  echo "# Technical Debt Report"
  echo
  echo "Generated: $(date -u +'%Y-%m-%d %H:%M:%SZ')"
  echo
  echo "## Metrics"
  echo
  echo "| Signal | Count | Notes |"
  echo "|---|---:|---|"
  echo "| TODO/FIXME/HACK/XXX markers | $TODO_COUNT | Potential unfinished work or deferred cleanup |"
  echo "| TypeScript 'any' usages in src/*.ts | $ANY_COUNT | Potential type-safety erosion |"
  echo "| console logging statements | $CONSOLE_COUNT | Potential noisy logs / inconsistent observability |"
  echo "| ts-ignore / ts-expect-error | $TS_IGNORE_COUNT | Type errors intentionally bypassed |"
  echo "| Test files (src/*.test.ts) | $TEST_FILES | Proxy for direct test coverage footprint |"
  echo "| TypeScript source files (src/*.ts) | $SOURCE_FILES | Codebase size proxy |"
  echo
  echo "## Initial Findings"
  echo
  echo "1. Review all type-safety bypasses and reduce any and ignore directives where practical."
  echo "2. Standardize runtime logging strategy and prune debug-only console output."
  echo "3. Convert deferred TODO/FIXME/HACK/XXX items into tracked backlog issues with owners."
  echo
  echo "## Suggested Next Actions"
  echo
  echo "- Prioritize high-impact, low-effort fixes first (e.g., remove stale TODOs, replace obvious any annotations)."
  echo "- Add or tighten tests around files touched by remediation work."
  echo "- Re-run this audit after each debt-reduction PR to track trend direction."
} > "$OUT_FILE"

echo "Wrote $OUT_FILE"
