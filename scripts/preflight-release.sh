#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"

if [[ "${SKIP_MEP_PREPUSH:-0}" == "1" ]]; then
  echo "Release certification refuses SKIP_MEP_PREPUSH=1." >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(`.`)[0]')"
if [[ "$node_major" != "22" ]]; then
  echo "Release certification requires Node 22; found $(node --version)." >&2
  exit 1
fi

echo "==> Clean dependency install"
npm ci

echo "==> Provision Playwright Chromium"
npx playwright install chromium

echo "==> Full local push gate"
./scripts/pre-push.sh

echo "==> Dependency audit"
npm audit --audit-level=high --ignore-scripts

echo "==> Static production build"
npm run build:static

echo "==> MANUAL STEP REQUIRED: installed-PWA verification"
echo "Open the static site in desktop Chromium with an isolated folder, install Enplace,"
echo "and confirm reload, offline launch, direct Markdown writes, /, and /shopping."

echo "==> Public snapshot"
echo "After certification, publish this commit to the public repository with:"
echo "  scripts/publish-public.sh"
echo "and redeploy the static site with scripts/deploy-site.sh."

echo "Automated preflight release checks passed; manual installed-PWA certification remains required."
