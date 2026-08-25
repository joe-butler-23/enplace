#!/usr/bin/env bash
# Fast secrets / personal-residue guardrail for outgoing pushes.
#
# Usage:
#   residue-scan.sh              # scan all tracked files in the worktree
#   residue-scan.sh --pre-push   # read pre-push stdin refs; scan changed files only
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"

# Personal residue + common secret key formats. One line must not match any.
CONTENT_PATTERN='joebutler|joesdownloads|joeb\.92|minworker|tail23ee7b|Bridge Club|Grace|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{30,}|tskey-[A-Za-z0-9]|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY'
# Lines matching this are legitimate technical usage, not residue.
CONTENT_ALLOWLIST='modifierGraceMs|graceMs|grace_ms|gracePeriod|grace period|GRACE_|[Gg]raceful'
# Paths that must never leave the machine.
PATH_DENY_PATTERN='(^|/)\.memory_tmp/|(^|/)backups/sync-backup|^\.beads/|^\.claude/|^\.codex/'

hits=0

check_paths() {
  local bad
  bad="$(grep -E "$PATH_DENY_PATTERN" <<<"$1" || true)"
  if [[ -n "$bad" ]]; then
    echo "RESIDUE: denied path(s) in push:" >&2
    echo "$bad" >&2
    hits=1
  fi
}

scan_content() { # $1 = tree-ish, rest = pathspecs
  local tree="$1"; shift
  local found
  found="$(git grep -h -n -E "$CONTENT_PATTERN" "$tree" -- "$@" 2>/dev/null || true)"
  found="$(grep -v -E "$CONTENT_ALLOWLIST" <<<"$found" || true)"
  if [[ -n "$found" ]]; then
    echo "RESIDUE: forbidden content in pushed files ($tree):" >&2
    head -20 <<<"$found" >&2
    hits=1
  fi
}

if [[ "${1:-}" == "--pre-push" ]]; then
  empty_tree="$(git hash-object -t tree /dev/null)"
  while read -r local_ref remote_ref; do
    if [[ "$local_ref" == *0000000000000000000000000000000000000000 ]]; then
      continue # branch deletion: nothing to scan
    fi
    if [[ "$remote_ref" == *0000000000000000000000000000000000000000 ]]; then
      base="$empty_tree"
    else
      base="${remote_ref#refs/*/}"
      base="$(git rev-parse "$remote_ref")"
    fi
    mapfile -t changed < <(git diff --name-only "$base" "$local_ref")
    ((${#changed[@]})) || continue
    printf '%s\n' "${changed[@]}" | check_paths "$(printf '%s\n' "${changed[@]}")"
    scan_content "$local_ref" "${changed[@]}"
  done
else
  bad="$(git ls-files | grep -E "$PATH_DENY_PATTERN" || true)"
  if [[ -n "$bad" ]]; then
    echo "RESIDUE: denied tracked path(s):" >&2
    echo "$bad" >&2
    hits=1
  fi
  scan_content HEAD .
fi

if ((hits)); then
  echo "" >&2
  echo "Push blocked: personal residue or secrets detected." >&2
  echo "Fix the flagged files, or export SKIP_MEP_RESIDUE_SCAN=1 only with explicit approval." >&2
  exit 1
fi

echo "Residue scan passed."
