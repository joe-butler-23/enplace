# Engineering Guardrails

Status: Active

## Debugging Workflow

1. Define exact expected behaviour before changing code.
2. Collect evidence from one layer at a time: state, DOM, then computed layout.
3. Keep one smallest reproducible case stable while debugging.
4. Test one ranked hypothesis per change.
5. Remove temporary instrumentation after the fix.
6. Preserve the winning invariant in a discriminating test or existing contract.

## Code Simplification Standards

- Preserve observable behaviour during refactors.
- Prefer explicit branches and named helpers over nested conditionals.
- Add explicit return types to exported APIs.
- Remove obsolete adapters, flags, tests, docs, and configuration with their surface.

## Weekly Planner Layout Invariants

- The grid uses five tracks: marked plus four day lanes per row.
- All tracks share `--col-min-width`.
- Extra width distributes equally with `1fr`.
- Narrow viewports keep the minimum width and scroll horizontally.
- The marked-column divider updates the shared minimum width only.

## Verification

Run targeted unit tests first, then:

```bash
npm run typecheck
npm test
npm run build:static
npm run test:static-pwa
```

The static-PWA suite must use synthetic data and an in-process relay. It proves that a fresh visit gets a seeded kitchen, kitchen writes survive reload, two contexts sharing one link converge through the relay, the folder opt-in still works on Chromium, and the app shell reloads offline.

Before a release, use a phone browser and desktop Chromium at the final static origin with a throwaway kitchen. Confirm the sample recipes appear, make one shopping edit on each device, watch it arrive on the other, reload, and verify the edit persists. Also verify `/` and `/shopping`, zip export, offline reload, and installability.

Never use the live vault as a fixture.
