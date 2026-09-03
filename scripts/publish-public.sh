#!/usr/bin/env bash
# Publish the current tree as one release snapshot on the public repository.
#
# The private repository's history carries personal residue and never leaves this
# machine. The public repository receives a squashed copy of the tree at each
# release, so it is always a faithful photograph of a released commit and never
# drifts for longer than one release.
#
# Usage:
#   scripts/publish-public.sh            # publish HEAD
#   scripts/publish-public.sh --dry-run  # build the snapshot, show the diff, push nothing
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PUBLIC_REMOTE="${ENPLACE_PUBLIC_REMOTE:-git@github.com:joe-butler-23/enplace.git}"
PUBLIC_BRANCH="${ENPLACE_PUBLIC_BRANCH:-main}"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

if [[ -n "$(git status --porcelain)" ]]; then
  echo "publish-public: the working tree must be clean (commit or stash first)." >&2
  exit 1
fi

echo "==> Residue scan of the full tree"
./scripts/residue-scan.sh

SHA="$(git rev-parse --short=12 HEAD)"
VERSION="$(node -p "require('./package.json').version")"
STAMP="$(date -u +%Y-%m-%d)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Fetching the public repository"
git clone -q --depth 1 --branch "$PUBLIC_BRANCH" "$PUBLIC_REMOTE" "$WORK/public"

echo "==> Replacing its contents with the tree at $SHA"
(cd "$WORK/public" && git ls-files -z | xargs -0 rm -f)
git archive --format=tar HEAD | tar -x -C "$WORK/public"
# Nothing under these paths belongs outside this machine, whatever the tree holds.
rm -rf "$WORK/public/.beads" "$WORK/public/.claude" "$WORK/public/.codex" "$WORK/public/.memory_tmp"

{
  echo "> Published snapshot of a private repository, refreshed at each release. Source commit \`$SHA\`, $STAMP."
  echo
  cat "$WORK/public/README.md"
} > "$WORK/README.md"
mv "$WORK/README.md" "$WORK/public/README.md"

cd "$WORK/public"
git add -A
if git diff --cached --quiet; then
  echo "publish-public: the public repository already matches $SHA."
  exit 0
fi
echo "==> Snapshot diff summary"
git diff --cached --stat | tail -5

MESSAGE="Enplace $VERSION: release snapshot of $SHA ($STAMP)"
TAG="release-$STAMP-$SHA"
git -c user.name="Enplace release" -c user.email="release@enplace.invalid" commit -q -m "$MESSAGE"
git tag -f "$TAG"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "publish-public: dry run, nothing pushed. Would push $TAG to $PUBLIC_REMOTE $PUBLIC_BRANCH."
  exit 0
fi

echo "==> Pushing $TAG"
git push -q origin "HEAD:$PUBLIC_BRANCH"
git push -q origin "refs/tags/$TAG"
echo "publish-public: published $SHA as $TAG."
