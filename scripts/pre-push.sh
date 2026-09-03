#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Running pre-push checks"

if [[ "${1:-}" == "--pre-push" ]]; then
  "${ROOT_DIR}/scripts/residue-scan.sh" --pre-push
else
  "${ROOT_DIR}/scripts/residue-scan.sh"
fi

if [[ "${SKIP_MEP_PREPUSH:-0}" == "1" ]]; then
  echo "Skipping expensive pre-push checks (SKIP_MEP_PREPUSH=1); residue scan passed."
  exit 0
fi

if [[ ! -d "${ROOT_DIR}/node_modules" ]]; then
  echo "node_modules is missing. Run 'npm ci' before pushing." >&2
  exit 1
fi

"${ROOT_DIR}/scripts/pre-commit.sh"

(
  cd "${ROOT_DIR}"
  npm run typecheck
  npm test
  npm run test:kanban-provenance
  npm run test:kanban-client
  npm run test:static-pwa
)

echo "Pre-push checks passed."
