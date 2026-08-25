# Repository Architecture

## Purpose

This document defines the module and runtime boundaries for Enplace. The product is a self-hosted web cooking application with an installable PWA client, plus a Rust CLI for validated recipe import.

## Runtime Surfaces

- Web host: `scripts/start-web-host.mjs` serves the web build (`dist-web/`) and a bounded vault API; `mep-remote-host-helper/` provides native helper operations. Clients install the app as a PWA. See `web-host-mode.md`.
- CLI: `mep-cli/` exposes validated recipe import over shared Rust code. See `mep-cli-contracts.md`.
- Agent workflow: `.agents/skills/recipe-extraction/SKILL.md` extracts a recipe
  from a URL, pasted text, or image and passes canonical Markdown only to
  `mep recipe import`. Product runtimes contain no recipe-extraction provider.

## Top-Level Ownership

- `src/`: React frontend, feature modules, services, and standalone runtime abstractions.
- `src/App.tsx`: application shell and runtime wiring.
- `src/host-client/invoke.ts`: host transport (HTTP-backed `invoke` and event channels).
- `src/host-client/commands.ts`: typed `mep_*` command boundary used by all frontend features.
- `mep-core/`: shared config, recipe, pipe-ingredient, shopping, thumbnail, URL-safety, and watch primitives.
- `mep-cli/src/main.rs`: canonical CLI command surface.
- `mep-cli/src/commands/recipe/`: validated Markdown import and rendering.
- `mep-remote-host-helper/`: native helper used by the web host.
- `tests/`: Playwright smoke and diagnostic suites.
- `docs/`: active product, architecture, safety, QA, and release contracts.

## Layering Rules

1. Frontend features under `src/modules/**` must not use the host transport (`src/host-client/invoke.ts`) directly.
2. All `mep_*` command calls must be centralized in `src/host-client/commands.ts`.
3. Shared Rust primitives belong in `mep-core`; command orchestration belongs in `mep-cli`.
4. Browser-host code must preserve the host-owned vault mount and must not expose arbitrary host filesystem access to clients.

## Placement Checks

```bash
npm run typecheck
npm test
nix-shell --run 'cargo test --workspace'
```
