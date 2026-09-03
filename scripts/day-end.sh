#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-quick}"
NODE_BIN="${NODE_BIN:-node}"
NPM_BIN="${NPM_BIN:-npm}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[day-end] required command not found: $1" >&2
    exit 1
  fi
}

require_cmd git
require_cmd "$NODE_BIN"
require_cmd "$NPM_BIN"

cd "$ROOT_DIR"
echo "[day-end] mode: $MODE"
echo "[day-end] syncing tracked hooks"
./scripts/install-git-hooks.sh

echo "[day-end] running quick checks"
./scripts/pre-commit.sh

if [[ "$MODE" == "full" ]]; then
  echo "[day-end] running full checks"
  "$NPM_BIN" run typecheck
  "$NPM_BIN" test
fi

echo "[day-end] repository status"
git status -sb
