# Purpose — mise-en-place

Enplace is the local-first cooking application and automation surface for recipe import, weekly planning, cooking, and shopping. It provides an authenticated self-hosted web application with an installable PWA client, and the `mep` CLI, over shared domain code.

Success means the hosted and CLI surfaces preserve their declared cooking contracts; recipe provenance and source truth remain visible; shopping changes are deterministic, previewable, and recoverable; the interface remains fast and coherent; and no runtime, adapter, cache, or integration becomes a second authority for the same data.

<!-- clai:instructions:coding:start -->
<!-- source-sha256:125fbd0ba45f15bcd8964ecd8bb5dd139da49002dbaf2db8229a6156593a274e -->
## Engineering Principles

- **Modern and idiomatic:** Use current, supported language, framework, and platform conventions. Match surrounding code when it is sound; do not reproduce obsolete patterns merely for consistency.
- **Lean end state:** Implement the intended final design directly. Remove superseded code, compatibility paths, shims, flags, dependencies, tests, comments, documentation, and configuration unless compatibility or migration is an explicit requirement. Git preserves history; current files describe only the current system.
- **Simple and explicit:** Use the least code and fewest moving parts that solve the problem. Prefer clear contracts, bounded resources, observable state, and existing project or platform primitives over speculative abstractions.
- **Efficient by design:** Avoid repeated work and unnecessary process, file, database, or network round trips. Reuse long-lived resources, batch small operations, stream large inputs, and keep concurrency, buffering, and retries bounded.
- **Evidence-led performance:** Set budgets and measure realistic workloads before optimizing. Fix algorithms, I/O, contention, and lifecycle design before micro-optimizing.
- **Risk-proportionate verification:** Define success before editing. Run the cheapest sufficient checks first and escalate according to risk. Bugs require regression coverage, and completion requires evidence at the surface the user cares about.
- **Timing and state:** Use time to model time, not to infer state. When work involves polling, debounce, readiness, timeouts, TTLs, cooldowns, throttling, retries, scheduling, animation timing, or event delivery, load the `timer-inference` skill.
<!-- clai:instructions:coding:end -->

## Repository Boundaries

- The selected vault owns recipe markdown and planner-note content. App data owns settings, the activity ledger, and the authoritative built-in shopping list. Caches, indexes, thumbnails, and browser fixtures are derived state.
- `mep-core` owns shared Rust domain primitives. `mep-cli`, `scripts/start-web-host.mjs`, and `mep-remote-host-helper` are integration surfaces.
- Known TypeScript/Rust differences are explicit contract locks in `docs/cooking-domain-contract.md`. Do not silently normalise them or create another implementation of the same semantics.
- Frontend features must not call the host transport directly. Centralise `mep_*` invokes in `src/host-client/commands.ts`; all requests go through the web host HTTP API.
- The `mep` CLI is the canonical agent-facing interface for recipe import. Its generated help owns command syntax; linked contracts own domain semantics.
- Treat recipe import as a vault write.
- Web-host mode is a trusted local or private-tailnet runtime, not an internet-facing multi-tenant service. Keep it loopback-bound and preserve its authenticated filesystem boundary.
- `.agents/skills/recipe-extraction/SKILL.md` owns extraction of new recipes from URLs, pasted text, or images and writes only through `mep recipe import`. `.agents/skills/mep-ai-led-qa/SKILL.md` is the sole authority for read-only QA of existing recipes.

## Working Contract

- Use Node 22 and `npm ci` for a clean dependency install. Pure TypeScript lint, typecheck, and unit tests may run directly; use `nix-shell` for Rust workspace and Playwright work.
- Never use the live vault as a test fixture. Load the project `recipe-extraction` skill for a new recipe import and `mep-ai-led-qa` for read-only existing-recipe review. Test importer changes only against an isolated recipes directory.
- Use `docs/repo-architecture.md` for module ownership; `docs/mep-cli-contracts.md` and `docs/cooking-domain-contract.md` for recipe and cooking semantics; `docs/weekly-planner-behaviour.md` and `docs/kanban-core-contract.md` for planner work; and `docs/web-host-mode.md` and `docs/engineering-guardrails.md` for runtime proof, plus `docs/security-baseline.md` for the security baseline.

## Verification

During implementation, run the cheapest affected checks:

```bash
npm run precommit
npm run typecheck
npm test -- <focused-test>
nix-shell --run 'cargo test -p <affected-crate>'
```

Run `npm run prepush` before pushing a normal code tranche, plus `nix-shell --run 'cargo test --workspace'` when Rust or cross-surface contracts changed.

Browser smoke tests exercise synthetic web-host data. Verify served-surface changes against a real browser boot of `npm run host:web`, including PWA installability of the manifest.

For project-skill changes, run:

```bash
clai validate skill mep-ai-led-qa --scope project --project-root .
clai validate skill recipe-extraction --scope project --project-root .
clai validate all --scope project --project-root .
```

For a release boundary, run `nix-shell --run './scripts/preflight-release.sh'` and complete the hosted checks printed by that script.
