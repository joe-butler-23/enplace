# Purpose — mise-en-place

Enplace is a local-first cooking application for recipe import, weekly planning, cooking, and shopping. It is one static PWA over a **shared cookbook**: one merge document per household, keyed by folder-relative path, held on every device and synced through a relay, addressed by an unguessable link. Plain Markdown is the schema; a folder on disk is a mirror of the cookbook, never a second authority.

Success means the cookbook document remains the sole authority; recipe provenance stays visible; shopping changes merge deterministically across devices; the cookbook is always exportable as plain files; and the interface remains fast and coherent.

<!-- clai:instructions:coding:start -->
<!-- source-sha256:125fbd0ba45f15bcd8964ecd8bb5dd139da49002dbaf2db8229a6156593a274e -->
## Engineering Principles

- **Modern and idiomatic:** Use current, supported language, framework, and platform conventions. Match surrounding code when it is sound; do not reproduce obsolete patterns merely for consistency.
- **Lean end state:** Implement the intended final design directly. Remove superseded code, compatibility paths, shims, flags, dependencies, tests, comments, documentation, and configuration unless compatibility or migration is an explicit requirement. Git preserves history; current files describe only the current system.
- **Simple and explicit:** Use the least code and fewest moving parts that solve the problem. Prefer clear contracts, bounded resources, observable state, and existing project or platform primitives over speculative abstractions.
- **Efficient by design:** Avoid repeated work and unnecessary process, file, database, or network round trips. Reuse long-lived resources, batch small operations, stream large inputs, and keep concurrency, buffering, and retries bounded.
- **Evidence-led performance:** Set budgets and measure realistic workloads before optimizing. Fix algorithms, I/O, contention, and lifecycle design before micro-optimizing.
- **Risk-proportionate verification:** Define success before editing. Run the cheapest sufficient checks first and escalate according to risk. Bugs require regression coverage, and completion requires evidence at the surface the user cares about.
- **Instant, never animated:** every interaction paints its final state in the same frame. No CSS transitions or animations, no View Transitions, no loading screens, spinners, skeletons, or fades; if something is slow enough to want one, make it fast instead. `scripts/lint-motion.sh` enforces this at commit time.
- **Fundamentals before tricks:** make the code and the bytes right first; caching, prewarming, prioritisation, and lazy loading come only after the measured floor is reached, because each of them can disguise an inefficiency elsewhere.
- **Timing and state:** Use time to model time, not to infer state. When work involves polling, debounce, readiness, timeouts, TTLs, cooldowns, throttling, retries, scheduling, animation timing, or event delivery, load the `timer-inference` skill.
<!-- clai:instructions:coding:end -->

## Repository Boundaries

- The cookbook document (`src/cookbook/doc.ts`) is the sole authority for recipe Markdown, `Plan.md`, and `Shopping.md`. Browser storage holds the cookbook's own persisted copy, the current cookbook id, and UI preferences. A folder on disk is only a mirror made by the CLI or a plain-file export.
- Storage adapters live in `src/host-client/`: `cookbook-storage.ts` implements the browser adapter over Yjs, IndexedDB, and the relay; `browser-storage.ts` defines the adapter contract and storage helpers. Shared recipe, planning, and shopping rules belong in the pure TypeScript `src/core.ts`.
- The optional `mep` Node CLI lives in `cli/`, uses plain filesystem access, imports the same `src/core.ts` and `src/cookbook/doc.ts`, and owns the folder mirror (`mep mirror`).
- The only network transport is the y-websocket relay connection for the cookbook document. Frontend features must not add another transport, a second store for cookbook content, accounts, or provider sign-in. Recipe extraction stays outside the app (paste, chat-assistant prompt, agents).
- `cooking/enplace-shared-cookbook.md` in the vault records the design decision and the provider-API evidence behind it.
- `.agents/skills/recipe-extraction/SKILL.md` owns agent-led extraction and CLI addition. `.agents/skills/recipe-qa/SKILL.md` owns read-only QA of existing recipes.

## Working Contract

- Use the exact Node 22 release pinned in `.nvmrc`. Run `npm ci` only at the repository root; that one workspace install owns the app, optional CLI, and production relay. `npm run typecheck` checks the app and relay, while `npm run build:release` builds the static app, CLI, and relay dry-run bundle. Use the configured Playwright command for browser work.
- Never use the live vault as a test fixture. Use isolated data for importer, browser, and file-write tests.
- Use `docs/repo-architecture.md` for module ownership, `docs/cooking-domain-contract.md` for cooking semantics, `docs/weekly-planner-behaviour.md` for planner work, and `docs/engineering-guardrails.md` for verification.

## Verification

During implementation, run the cheapest affected checks:

```bash
npm run precommit
npm run typecheck
npm test -- <focused-test>
```

Run `npm run prepush` before pushing a normal code tranche.

Browser smoke tests use synthetic data and an in-process relay. Verify primary-surface changes against a real browser boot of the static PWA, including a fresh cookbook, edits surviving reload, two contexts converging through the relay, zip export, offline reload, and PWA installability.

For project-skill changes, run:

```bash
clai validate skill recipe-extraction --scope project --project-root .
clai validate skill recipe-qa --scope project --project-root .
clai validate all --scope project --project-root .
```

For a release boundary under the pinned Node 22, run `npm run preflight:release`; this is the clean-checkout app/CLI/relay gate. Complete the static-PWA checks printed by that script. A release is not finished until `scripts/publish-public.sh` has pushed the snapshot to the public repository (`joe-butler-23/enplace`, a squashed projection of this private repository) and the static site has been redeployed.
