#!/usr/bin/env bash
set -euo pipefail

# Recipe audit helper
# Usage:
#   ./scripts/recipe-audit.sh [recipes_dir] [vault_root]
# Defaults:
#   recipes_dir=$HOME/vault/cooking/recipes
#   vault_root=$HOME/vault/cooking

RECIPES_DIR="${1:-$HOME/vault/cooking/recipes}"
VAULT_ROOT="${2:-$HOME/vault/cooking}"

if [[ ! -d "$RECIPES_DIR" ]]; then
  echo "error: recipes dir not found: $RECIPES_DIR" >&2
  exit 1
fi

resolve_path() {
  local raw="$1"
  local md_path="$2"
  local cleaned="${raw%%|*}"
  cleaned="${cleaned#<}"
  cleaned="${cleaned%>}"
  cleaned="${cleaned#./}"
  [[ -z "$cleaned" ]] && return 1

  if [[ "$cleaned" =~ ^https?:// ]] || [[ "$cleaned" =~ ^data: ]] || [[ "$cleaned" =~ ^blob: ]]; then
    echo "EXTERNAL"
    return 0
  fi

  if [[ "$cleaned" == /* ]]; then
    echo "$cleaned"
    return 0
  fi

  local md_dir
  md_dir="$(dirname "$md_path")"
  local rel_try root_try
  rel_try="$(realpath -m "$md_dir/$cleaned")"
  root_try="$(realpath -m "$VAULT_ROOT/$cleaned")"

  if [[ -f "$rel_try" ]]; then
    echo "$rel_try"
    return 0
  fi

  if [[ -f "$root_try" ]]; then
    echo "$root_try"
    return 0
  fi

  echo "$rel_try"
}

audit_cover_empty() {
  echo "== Empty/Missing Cover =="
  local found=0
  while IFS= read -r md; do
    if rg -q '^cover:\s*$' "$md" || ! rg -q '^(cover|image):\s*\S.+' "$md"; then
      echo "- $(basename "$md")"
      found=1
    fi
  done < <(find "$RECIPES_DIR" -maxdepth 1 -type f -name '*.md' | sort)
  [[ $found -eq 0 ]] && echo "- none"
  echo
}

audit_missing_cover_targets() {
  echo "== Broken Cover/Image Targets =="
  local found=0
  while IFS= read -r md; do
    local line raw resolved
    line="$(rg -n '^(cover|image):\s*(.+)$' -m 1 "$md" || true)"
    [[ -z "$line" ]] && continue
    raw="$(printf '%s' "$line" | sed -E 's/^[0-9]+:(cover|image):\s*//')"
    resolved="$(resolve_path "$raw" "$md" || true)"
    [[ -z "$resolved" || "$resolved" == "EXTERNAL" ]] && continue
    if [[ ! -f "$resolved" ]]; then
      echo "- $(basename "$md"): $raw"
      found=1
    fi
  done < <(find "$RECIPES_DIR" -maxdepth 1 -type f -name '*.md' | sort)
  [[ $found -eq 0 ]] && echo "- none"
  echo
}

audit_broken_inline_images() {
  echo "== Broken Inline Markdown Images =="
  local found=0
  while IFS= read -r md; do
    while IFS= read -r line; do
      local raw resolved
      raw="$(printf '%s' "$line" | sed -E 's/^[0-9]+:.*!\[[^]]*\]\(([^)]+)\).*/\1/')"
      resolved="$(resolve_path "$raw" "$md" || true)"
      [[ -z "$resolved" || "$resolved" == "EXTERNAL" ]] && continue
      if [[ ! -f "$resolved" ]]; then
        echo "- $(basename "$md"): $raw"
        found=1
      fi
    done < <(rg -n '!\[[^\]]*\]\([^)]+\)' "$md" || true)
  done < <(find "$RECIPES_DIR" -maxdepth 1 -type f -name '*.md' | sort)
  [[ $found -eq 0 ]] && echo "- none"
  echo
}

audit_missing_recipe_image_line() {
  echo "== Missing Inline Recipe Image Line =="
  local found=0
  while IFS= read -r md; do
    if rg -q '^type:\s*recipe\s*$' "$md"; then
      if ! rg -q '^!\[Recipe Image\]\(.+\)$' "$md"; then
        echo "- $(basename "$md")"
        found=1
      fi
    fi
  done < <(find "$RECIPES_DIR" -maxdepth 1 -type f -name '*.md' | sort)
  [[ $found -eq 0 ]] && echo "- none"
  echo
}

audit_method_numbering_glitch() {
  echo "== Method Numbering Glitch (e.g. 1. 1:) =="
  local found=0
  while IFS= read -r md; do
    if rg -q '^\d+\.\s+\d+:' "$md"; then
      echo "- $(basename "$md")"
      found=1
    fi
  done < <(find "$RECIPES_DIR" -maxdepth 1 -type f -name '*.md' | sort)
  [[ $found -eq 0 ]] && echo "- none"
  echo
}

audit_non_recipe_files() {
  echo "== Non-Recipe Markdown Files In Recipes Dir =="
  local found=0
  while IFS= read -r md; do
    if ! rg -q '^type:\s*recipe\s*$' "$md"; then
      echo "- $(basename "$md")"
      found=1
    fi
  done < <(find "$RECIPES_DIR" -maxdepth 1 -type f -name '*.md' | sort)
  [[ $found -eq 0 ]] && echo "- none"
  echo
}

echo "Recipe audit"
echo "recipes_dir: $RECIPES_DIR"
echo "vault_root:  $VAULT_ROOT"
echo

audit_cover_empty
audit_missing_cover_targets
audit_broken_inline_images
audit_missing_recipe_image_line
audit_method_numbering_glitch
audit_non_recipe_files
