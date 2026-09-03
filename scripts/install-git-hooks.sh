#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"

if command -v bd >/dev/null 2>&1; then
  bd hooks install --beads
fi

git config core.hooksPath .githooks
echo "Git hooks installed: Beads lifecycle plus Enplace verification (.githooks)."
