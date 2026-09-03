#!/usr/bin/env bash
# Fast secrets / personal-residue guardrail for outgoing pushes.
#
# Usage:
#   residue-scan.sh              # scan all tracked files in the worktree
#   residue-scan.sh --pre-push   # read pre-push stdin refs; scan changed files only
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"

# Personal deployment residue + common secret formats.
CONTENT_PATTERN='/home/[A-Za-z0-9._-]+/|[A-Za-z0-9.-]+\.ts\.net|[A-Za-z0-9._%+-]+@(gmail|hotmail|outlook)\.com|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{30,}|tskey-[A-Za-z0-9]|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY'
# Remove only stable synthetic fixture values before testing the remainder of
# each matching line. Dropping a whole allowlisted line would let a real secret
# hide beside a fixture path.
CONTENT_ALLOWLIST='/home/(student|test|vault)/|[A-Za-z0-9.-]*example\.ts\.net'
# Paths that must never leave the machine.
PATH_DENY_PATTERN='(^|/)\.memory_tmp/|(^|/)backups/sync-backup|^\.beads/|^\.claude/|^\.codex/'

hits=0

check_paths() { # remaining args = paths
  local bad=""
  if (($#)); then
    bad="$(printf '%s\n' "$@" | grep -E "$PATH_DENY_PATTERN" || true)"
  fi
  if [[ -n "$bad" ]]; then
    echo "RESIDUE: denied path(s) in push:" >&2
    echo "$bad" >&2
    hits=1
  fi
}

scan_content() { # $1 = tree-ish or --worktree, rest = paths
  local tree="$1"; shift
  local pathspecs=()
  local path
  for path in "$@"; do
    pathspecs+=(":(literal)${path}")
  done
  local found
  if [[ "$tree" == "--worktree" ]]; then
    found="$(git grep -n -E "$CONTENT_PATTERN" -- "${pathspecs[@]}" 2>/dev/null || true)"
  else
    found="$(git grep -n -E "$CONTENT_PATTERN" "$tree" -- "${pathspecs[@]}" 2>/dev/null || true)"
  fi
  found="$(sed -E "s#${CONTENT_ALLOWLIST}##g" <<<"$found" | grep -E "$CONTENT_PATTERN" || true)"
  if [[ -n "$found" ]]; then
    echo "RESIDUE: forbidden content in pushed files ($tree):" >&2
    head -20 <<<"$found" >&2
    hits=1
  fi
}

if [[ "${1:-}" == "--pre-push" ]]; then
  changed_list="$(mktemp)"
  trap 'rm -f "${changed_list}"' EXIT
  while read -r local_ref local_sha remote_ref remote_sha; do
    [[ -n "${local_ref:-}" && -n "${local_sha:-}" && -n "${remote_ref:-}" && -n "${remote_sha:-}" ]] || {
      echo "RESIDUE: malformed pre-push ref record" >&2
      exit 2
    }
    if [[ "$local_sha" == "0000000000000000000000000000000000000000" ]]; then
      continue # branch deletion: nothing to scan
    fi
    commits=("$local_sha")
    if [[ "$remote_sha" != "0000000000000000000000000000000000000000" ]]; then
      commits+=("^$remote_sha")
    else
      # New remote ref: scan only commits not already published on a remote.
      commits+=(--not --remotes)
    fi
    if ! commit_list="$(git rev-list --reverse "${commits[@]}")"; then
      echo "RESIDUE: cannot enumerate outgoing commits" >&2
      exit 2
    fi
    while IFS= read -r commit; do
      [[ -n "$commit" ]] || continue
      changed=()
      if ! git diff-tree --root --no-commit-id --name-only -r -m -z "$commit" >"$changed_list"; then
        echo "RESIDUE: cannot inspect outgoing commit $commit" >&2
        exit 2
      fi
      while IFS= read -r -d '' path; do
        changed+=("$path")
      done <"$changed_list"
      ((${#changed[@]})) || continue
      check_paths "${changed[@]}"
      scan_content "$commit" "${changed[@]}"
    done <<<"$commit_list"
  done
else
  tracked=()
  while IFS= read -r -d '' path; do
    tracked+=("$path")
  done < <(git ls-files -z)
  check_paths "${tracked[@]}"
  scan_content --worktree .
fi

if ((hits)); then
  echo "" >&2
  echo "Push blocked: personal residue or secrets detected." >&2
  echo "Remove the flagged content before publishing." >&2
  exit 1
fi

echo "Residue scan passed."
