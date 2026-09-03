# Contributing

Thanks for looking at Enplace. This project is early-stage and largely
agent-developed, so the engineering contract lives in agent-readable form.

## Read first

- [AGENTS.md](AGENTS.md) — the working contract: engineering principles,
  repository boundaries, and verification requirements. Follow it.
- [docs/repo-architecture.md](docs/repo-architecture.md) — module ownership
  and boundaries before you change code.

## Verification

Contributor tooling and tracked verification scripts are written for Bash. On
Windows, use Git Bash or WSL for contributing.

Install the browser engines and tracked hooks once after cloning. The hooks compose
Enplace checks with the repository's Beads lifecycle hooks when `bd` is available:

```bash
npx playwright install chromium
npx playwright install webkit firefox
npm run setup:hooks
```

Run the cheapest checks that cover your change, and escalate with risk:

```bash
npm run precommit        # fast provider/credential-boundary lint
npm run typecheck
npm test -- <focused-test>
```

Before pushing a normal code tranche, run `npm run prepush`. It runs the
publication-residue scan, typecheck, the full Vitest suite, kanban provenance,
and the static-PWA browser contract.
At a publication boundary, run the complete Node 22 release gate:

```bash
nix-shell --run './scripts/preflight-release.sh'
```

## Verification plane

Verification is local: the tracked hooks in [.githooks/](.githooks/) run the
fast commit check and full push gate while preserving Beads hooks. A push hook
is not a release certificate: the preflight also audits dependencies and the
static PWA needs the manual browser checks printed by that script.

## Ground rules

- Recipes and planner content belong to the user's vault; app data and derived
  caches stay in their own lanes. Never treat the live vault as a test fixture.
- Do not create a second implementation of semantics already owned by a
  contract in [docs/](docs/).
