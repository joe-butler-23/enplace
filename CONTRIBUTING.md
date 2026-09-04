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

On NixOS, the flake supplies exact Node 22.23.1 and version-matched
Playwright 1.58.2 browsers. Do not run `playwright install` in this shell.

```bash
nix develop --command npm ci
nix develop --command npm run check:playwright-runtime  # no browser launch
nix develop --command npm run setup:hooks
```

Outside NixOS, use the exact Node release in `.nvmrc` and Playwright's browser
installer. Always install the root workspace only; never install in `relay/`.

Run the cheapest checks that cover your change, and escalate with risk:

```bash
npm run precommit        # fast provider/credential-boundary lint
npm run typecheck        # app plus generated relay types and relay tsc
npm test -- <focused-test>
```

Before pushing a normal code tranche, run `npm run prepush`. It runs the
publication-residue scan, typecheck, the full Vitest suite, kanban provenance,
and the static-PWA browser contract.
At a publication boundary, run the release gate in the explicit Nix environment:

```bash
nix develop --command npm run preflight:release
```

## Verification plane

Verification is local: the tracked hooks in [.githooks/](.githooks/) run the
fast commit check and full push gate while preserving Beads hooks. A push hook
is not a release certificate. `npm run preflight:release` is the one authority: it
performs one clean workspace install, checks the app and generated relay types,
verifies the packed CLI, audits dependencies, builds the release, and probes
final `dist-static` through locked local Wrangler Pages dev. Real Safari,
installed-PWA checks, and the deployed CDN edge remain external.

## Ground rules

- Recipes and planner content belong to the user's kitchen; exported or mirrored
  files are projections. Never treat live personal data as a test fixture.
- Do not create a second implementation of semantics already owned by a
  contract in [docs/](docs/).
