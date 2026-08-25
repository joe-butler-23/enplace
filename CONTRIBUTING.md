# Contributing

Thanks for looking at Enplace. This project is early-stage and largely
agent-developed, so the engineering contract lives in agent-readable form.

## Read first

- [AGENTS.md](AGENTS.md) — the working contract: engineering principles,
  repository boundaries, and verification requirements. Follow it.
- [docs/repo-architecture.md](docs/repo-architecture.md) — module ownership
  and boundaries before you change code.

## Verification

Run the cheapest checks that cover your change, and escalate with risk:

```bash
npm run precommit        # lint + typecheck + unit tests gate
npm run typecheck
npm test -- <focused-test>
nix-shell --run 'cargo test -p <affected-crate>'   # Rust work (Linux)
```

Before pushing a normal code tranche, run `npm run prepush`, plus
`nix-shell --run 'cargo test --workspace'` when Rust or cross-surface
contracts changed.

## Verification plane

Verification is local: the git hooks in [.githooks/](.githooks/) run
`npm run precommit` on commit and `npm run prepush` before push. There is no
GitHub Actions CI and there are no release builds; the product runs from a
clone via [docs/web-host-mode.md](docs/web-host-mode.md).

## Ground rules

- Recipes and planner content belong to the user's vault; app data and derived
  caches stay in their own lanes. Never treat the live vault as a test fixture.
- The `mep` CLI is the canonical agent-facing write gate for recipe import.
- Do not create a second implementation of semantics already owned by a
  contract in [docs/](docs/).
