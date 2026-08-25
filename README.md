# Enplace

> Enplace was formerly known as Mise en Place; the `mep` CLI keeps its historical name.

Enplace is a local-first meal-planning app built on the professional kitchen's
mise en place discipline: get every ingredient prepped and in its place before
the heat is on. In the app that means your recipe collection is in order before
the week is, so cooking is execution instead of improvisation.

The weekly loop:

1. **Recipe database** — browse, search, and filter your recipes.
2. **Mark** the recipes you want this week.
3. **Plan** — drag them onto days on the weekly kanban board.
4. **Shop** — the built-in shopping list aggregates what you planned.

## Who it's for

Home cooks who plan their week and want their recipes somewhere durable:
people who cook from a rotating set of trusted recipes, shop once, and don't
want their meal planning held hostage by a web service.

## Your data is yours

- Recipes are **plain Markdown files** in a folder you own — a standard
  Obsidian-compatible vault. No proprietary database, no export step: your
  recipe library is already portable.
- The app is **local-first**. The self-hosted server reads and writes your
  folder on your own machine, over loopback or a private tailnet — it is a
  trusted household runtime, not a cloud service.
- No account, no telemetry, no lock-in. Stop using Enplace and your recipes
  are exactly where you left them.

## Quickstart

Enplace ships as a build-from-source self-hosted web app with an installable
PWA client.

Prerequisites: Node.js 22+ and Rust (for the helper binary).

```bash
npm ci
npm run build:remote-helper
npm run host:web
```

Then open `http://127.0.0.1:4173/`. Your browser should offer to install
Enplace as an app; the installed PWA is the full application, with the shared
shopping list one tap away at `/shopping`.

The host binds to loopback by default. On first start it asks where your vault
should live and creates `~/Enplace` if you accept the default — or point it at
an existing Obsidian-compatible folder:

```bash
npm run host:web -- --vault /path/to/your/vault   # skip the prompt entirely
```

To use it from
other household devices, publish it over Tailscale — see
[docs/web-host-mode.md](docs/web-host-mode.md).

### `mep` CLI

The `mep` CLI is the canonical, agent-friendly write gate for recipe import.
Recipe extraction itself (reading a URL, pasted text, or a photo) is done by
your coding agent using the bundled
[recipe-extraction skill](.agents/skills/recipe-extraction/SKILL.md); the
resulting Markdown is imported through the CLI:

```bash
cargo build --release -p mep-cli
./target/release/mep recipe import recipe.md --recipes-dir /path/to/vault/cooking/recipes
```

There are no prebuilt releases; building the CLI from this clone is the
supported path.

## Platforms

Enplace runs anywhere its server runs. The host is plain Node.js plus one Rust
helper binary, so any Linux, macOS, or Windows machine that builds those can
serve it; clients only need a modern browser.

## Screenshots

TODO: add current screenshots of the recipe database, weekly planner kanban,
and shopping list views.

## Architecture

Enplace is a React + TypeScript frontend served by an authenticated local web
host (`scripts/start-web-host.mjs`) over a shared Rust domain core used by the
host helper and the `mep` CLI. Module ownership and boundaries are documented
in [docs/repo-architecture.md](docs/repo-architecture.md). Key contracts:

- [docs/cooking-domain-contract.md](docs/cooking-domain-contract.md) — shared cooking semantics across TypeScript and Rust.
- [docs/mep-cli-contracts.md](docs/mep-cli-contracts.md) — CLI behaviour and data flow.
- [docs/kanban-core-contract.md](docs/kanban-core-contract.md) and [docs/weekly-planner-behaviour.md](docs/weekly-planner-behaviour.md) — planner behaviour.
- [docs/web-host-mode.md](docs/web-host-mode.md) — hosted browser runtime and its filesystem boundary.
- [docs/security-baseline.md](docs/security-baseline.md) — filesystem scope, security headers, and transport baseline.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Engineering principles, verification
commands, and CI layout live in [AGENTS.md](AGENTS.md).

## Status

Enplace is early, actively developed software, and largely agent-developed.
Interfaces and behaviour change; the cooking data contracts are the stable
part. Licensed under the [MIT license](LICENSE).
