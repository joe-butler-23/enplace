#!/usr/bin/env bash
# Enplace is instant, never animated. Fail on any motion primitive in the app's own
# stylesheets and source. Vendored planner code and tests are outside the rule.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
PATTERN='(^|[^a-z-])(transition|animation)(-[a-z]+)?[[:space:]]*:|@keyframes|startViewTransition|viewTransitionName|view-transition-name'
hits="$(grep -rn -E "$PATTERN" styles.css src --include='*.css' --include='*.ts' --include='*.tsx' \
  --exclude-dir=kanban-component --exclude-dir=vendor --exclude='*.test.*' --exclude='*.d.ts' || true)"
if [[ -n "$hits" ]]; then
  echo "Motion primitives are not allowed (see AGENTS.md, Instant, never animated):" >&2
  echo "$hits" >&2
  exit 1
fi
echo "Motion lint passed."
