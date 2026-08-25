#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Running pre-commit checks"
if [[ ! -x "${ROOT_DIR}/scripts/lint-provider-residue.sh" ]]; then
  echo "Missing executable lint-provider-residue.sh" >&2
  exit 1
fi
"${ROOT_DIR}/scripts/lint-provider-residue.sh"
echo "Pre-commit checks passed."
