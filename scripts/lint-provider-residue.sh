#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PATTERN='todoist|bridge[ _-]?club|gemini|@google/genai|GoogleGenAI|OPENAI_API_KEY|OPENAI_BASE_URL|MEP_LLM_MODEL|TODOIST_API_TOKEN|TODOIST_BASE_URL|TODOIST_PROJECT_ID|mep_(load|save)_secrets|secrets\.json|mep-todoist-sync|shopping_sync|recipe[[:space:]]+import-url'

targets=(
  "$ROOT_DIR/AGENTS.md"
  "$ROOT_DIR/CHANGELOG.md"
  "$ROOT_DIR/package.json"
  "$ROOT_DIR/package-lock.json"
  "$ROOT_DIR/.agents"
  "$ROOT_DIR/docs"
  "$ROOT_DIR/src"
)
existing_targets=()
for target in "${targets[@]}"; do
  [[ -e "$target" ]] && existing_targets+=("$target")
done

if grep -RInEi "$PATTERN" "${existing_targets[@]}"; then
  echo "Obsolete provider or credential residue remains." >&2
  exit 1
fi

echo "Provider residue lint passed."
