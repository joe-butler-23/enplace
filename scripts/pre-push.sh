#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "${SKIP_MEP_PREPUSH:-0}" == "1" ]]; then
  echo "Skipping pre-push checks (SKIP_MEP_PREPUSH=1)"
  exit 0
fi

echo "==> Running pre-push checks"

if [[ ! -d "${ROOT_DIR}/node_modules" ]]; then
  echo "node_modules is missing. Run 'npm ci' before pushing." >&2
  exit 1
fi

"${ROOT_DIR}/scripts/pre-commit.sh"

(
  cd "${ROOT_DIR}"
  npm run typecheck
  npm run test:kanban-provenance
  npm run test:startup
  npm run test -- src/modules/cooking/services/RecipeIndexService.test.ts
  # Perceptual diagnostics: catches drag regressions that unit
  # tests and typecheck cannot see (see docs/engineering-guardrails.md #7).
  if [[ "$(uname -s)" == "Linux" && -z "${IN_NIX_SHELL:-}" ]]; then
    nix-shell --run "npm run test:diagnostics && npm run test:kanban-client"
  else
    npm run test:diagnostics
    npm run test:kanban-client
  fi
)

echo "Pre-push checks passed."
