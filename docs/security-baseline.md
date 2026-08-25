# Security Baseline (Self-Hosted Web App)

Enplace ships as a self-hosted web application: `scripts/start-web-host.mjs`
serves the built frontend and the vault API, optionally published to a private
tailnet through Tailscale Serve. There is no native app surface and no
internet-facing multi-tenant deployment.

## Filesystem Boundary

- The host server process owns the only real filesystem access:
  - the mounted vault root (`~/Enplace` by default; host-managed, not
    client-selectable), and
  - the host app-data directory (`~/.mep-web-host` by default) for settings,
    shopping-list state, the activity ledger, and thumbnail caches.
- Browser clients never touch the filesystem directly. They call the host HTTP
  API (`/api/*`) with a bearer token issued when the server injects its runtime
  configuration into the served `index.html`.
- Path handling resolves and confines every request path under its root;
  traversal outside the vault or the dist directory is rejected.

## Transport and Access

- The server binds to loopback by default. Remote access goes through
  `tailscale serve`, which supplies an identity header the host requires before
  it accepts a non-loopback Host name. Funnel (public) traffic is rejected.
- Session tokens are delivered with `HttpOnly; SameSite=Strict` cookies scoped
  to the thumbnail route plus bearer headers for the API.
- The application requires no third-party API credentials. Recipe extraction
  runs in the active agent and reaches the product only through the
  provider-free `mep recipe import` gate.

## Security Headers

Every served response carries the security baseline set in
`scripts/start-web-host.mjs` (`SECURITY_HEADERS`):

- `Content-Security-Policy`: `default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:;
  connect-src 'self'; font-src 'self' data:; media-src 'self' data: blob:;
  object-src 'none'; frame-ancestors 'none'; base-uri 'self';
  form-action 'self'`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`

This re-expresses the CSP that previously lived in the native window config for
a same-origin web runtime: no `asset:`/`ipc:` schemes exist any more, and all
app traffic (API calls, server-sent events, thumbnails) is same-origin. Static
assets are additionally served gzip-compressed when the client advertises
support, so the bundle budget applies to what clients actually download.

## Verification

- `npm run precommit` runs the provider-residue lint (no credentials or
  third-party providers in the repo).
- `nix-shell --run './scripts/preflight-release.sh'` runs typecheck, unit and
  workspace Rust tests, dependency audit, the perceptual budgets, and prints
  the hosted-surface checks to complete manually.
