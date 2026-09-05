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

## Measured Rejections

Candidates that were tried against a recorded trace and rejected. Re-propose one only with new evidence.

- **`content-visibility: auto` on `.cooking-db__card` (2026-09-04).** Ten paired AB/BA runs at 112 and 500 synthetic cards, compositor-synthesised full-range scroll at 20,000 px/s, headless Chromium 145. Cold load render work fell (about 26% at 112 cards, 61% at 500) but full-range scroll render work rose at both sizes (112: 12 ms to 69 ms; 500: 218 ms to 575 ms; candidate lost 20 of 20 pairs) because every card that scrolls into view re-runs layout, style, and pre-paint. No blank patches were observed. The grid already fences each card with `contain: layout paint style`; that is the retained rule. The scroll cost that mattered was image decode of oversized covers, fixed by import-time resizing in `e22f8d8`.

## Verification

Run targeted unit tests first, then:

```bash
npm run typecheck        # app and production relay
npm test
npm run build:release    # static app, CLI, and relay dry-run bundle
npm run test:static-pwa
```

`npm ci` runs once at the root and installs the `relay/` workspace from the sole lockfile. The release authority is `npm run preflight:release`; do not reproduce its sequence in another script.

The static-PWA suite must use synthetic data and an in-process relay. It proves that a fresh visit gets a seeded cookbook, cookbook writes survive reload, two contexts sharing one link converge through the relay, file and zip transfers preserve cooking state, and the app shell reloads offline.

Before a release, use a phone browser and desktop Chromium at the final static origin with a throwaway cookbook. Confirm the sample recipes appear, make one shopping edit on each device, watch it arrive on the other, reload, and verify the edit persists. Also verify `/` and `/shopping`, zip export, offline reload, and installability.

Never use the live vault as a fixture.
