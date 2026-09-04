#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"

if [[ "${SKIP_MEP_PREPUSH:-0}" == "1" ]]; then
  echo "Release certification refuses SKIP_MEP_PREPUSH=1." >&2
  exit 1
fi

required_node="$(tr -d '[:space:]' < .nvmrc)"
actual_node="$(node -p 'process.versions.node')"
if [[ "$actual_node" != "$required_node" ]]; then
  echo "Release certification requires Node $required_node; found $(node --version)." >&2
  exit 1
fi

echo "==> Clean root/workspace dependency install"
npm ci

echo "==> Verify pinned Nix Playwright runtime"
npm run check:playwright-runtime

echo "==> Full three-engine local push gate"
ENPLACE_ENGINES=all ./scripts/pre-push.sh

echo "==> Root and workspace dependency audit"
npm audit --workspaces --include-workspace-root --audit-level=high --ignore-scripts

echo "==> App, CLI, and production relay release build"
npm run build:release

echo "==> Cloudflare Pages boundary"
npm run test:pages-boundary

echo "==> MANUAL STEP REQUIRED: installed-PWA verification"
echo "Open the static site in desktop Chromium with a throwaway cookbook, install Enplace,"
echo "and confirm a cookbook edit survives reload, offline launch, /, /shopping, and zip export."

echo "==> Public snapshot"
echo "After certification, publish this commit to the public repository with:"
echo "  scripts/publish-public.sh"
echo "and redeploy the static site with scripts/deploy-site.sh."

echo "Automated preflight release checks passed; manual installed-PWA certification remains required."
