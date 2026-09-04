#!/usr/bin/env bash
# Build the static site against the production relay and upload it to Cloudflare Pages.
# The Pages project is not connected to a repository; this script is the only deploy path.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
PROJECT="${ENPLACE_PAGES_PROJECT:-enplace-trial}"
echo "==> Building dist-static with .env.static"
npm run build:static >/dev/null
RELAY="$(grep -o -E "wss://[^\"'\` ]+" dist-static/assets/index-*.js | head -1 || true)"
[[ -n "$RELAY" ]] || { echo "deploy-site: the build has no relay URL; check .env.static" >&2; exit 1; }
echo "==> Relay in build: $RELAY"
echo "==> Deploying to Pages project $PROJECT"
[[ -x ./node_modules/.bin/wrangler ]] || {
  echo "deploy-site: ./node_modules/.bin/wrangler is missing or not executable; run npm ci at the repository root" >&2
  exit 1
}
./node_modules/.bin/wrangler pages deploy dist-static --project-name "$PROJECT" --branch main --commit-dirty=true
