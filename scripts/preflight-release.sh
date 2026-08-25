#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"

echo "==> Typecheck"
npm run typecheck

echo "==> Portable kanban provenance failure check"
npm run test:kanban-provenance

echo "==> Dependency audit"
npm audit --audit-level=high

echo "==> Startup path smoke test"
npm run test:startup

echo "==> Web frontend build (dist-web/, served by the web host)"
npm run build

echo "==> Rust workspace tests (mep-core, mep-cli, mep-remote-host-helper)"
if command -v nix-shell >/dev/null 2>&1; then
  nix-shell --run "cargo test --workspace"
else
  cargo test --workspace
fi

echo "==> Provision Playwright Chromium"
npx playwright install chromium

echo "==> Portable kanban client contract"
npm run test:kanban-client

echo "==> Perceptual release budgets (benchmark:recipe-scroll + check-release-budgets)"
npm run perf:release -- --output-dir target/release-evidence

echo "==> MANUAL STEP REQUIRED: hosted PWA install verification"
echo "Start the web host (npm run host:web), open the served URL, and confirm"
echo "the browser offers the Enplace install and the installed app launches"
echo "into the full app with the /shopping shortcut working."

echo "Preflight release checks passed."
