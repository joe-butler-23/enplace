# Engineering Guardrails

Status: Active  
Last updated: 2026-02-11

This is the default playbook for making changes in this repo without creating
layout regressions or dead-end debugging loops.

## 1) Debugging Workflow (Systematic)

1. Define exact expected behaviour before changing code.
1. Collect evidence from one layer at a time:
   - state/props
   - rendered DOM structure
   - computed CSS/layout
1. Build a smallest reproducible case and keep it stable while debugging.
1. Write 2-3 ranked hypotheses and test only one variable per change.
1. Add temporary instrumentation close to the suspected boundary (not global).
1. After each experiment: record result, keep/revert, and update hypothesis rank.
1. Once fixed: remove noisy logs and preserve the winning invariant in docs/tests.

## 2) Code Simplification Standards

- Preserve behaviour exactly. Refactors should change structure, not outcomes.
- Prefer `function` declarations for top-level helpers/exports over arrow
  function assignments.
- Add explicit return types for top-level functions and exported APIs.
- Avoid nested ternaries for multi-branch decisions; use explicit `if/else` or
  comparator maps.
- Favor small, named helpers over repeated inline branching logic.
- For React components, prefer explicit props interfaces and named components.

## 3) Weekly Planner Layout Invariants

- Weekly kanban grid uses 5 tracks (`marked + 4 day lanes per row`).
- All tracks share one minimum width variable: `--col-min-width`.
- Extra width distributes equally via `1fr` across all tracks.
- If viewport is too narrow, columns stay at minimum width and horizontal
  scrolling is expected.
- Marked-column drag handle updates the shared minimum width only.

If a change violates any invariant above, treat it as a regression.

## 4) Pre-merge Safety Checklist

- Run targeted unit tests first for touched modules.
- Run at least one end-to-end/manual flow that exercises changed UI behavior.
- Verify no temporary debug logs remain (unless behind explicit debug flag).
- Update behaviour docs when changing UX contracts.
- Prefer small, reversible commits over multi-surface refactors.

## 5) Testing Matrix (Minimum)

- `npm test src/modules/organiser/tests/*.test.ts`
- Manual weekly planner checks:
  - resize marked divider and confirm all columns track together
  - widen window and confirm equal expansion
  - narrow window and confirm horizontal scroll + minimum width lock
- For drag/drop latency analysis, enable `window.__MEP_KANBAN_DEBUG__ = true`
  in DevTools and inspect timing logs (`drag:copy:*`, `drag:drop:*`, `refresh:*`).

### Deterministic Web Diagnostics

- Web-mode shim filesystem now seeds a deterministic planner fixture vault at
  `/home/vault` by default so drag/drop diagnostics always have cards to use.
- The fixture includes:
  - at least one day with 2 recipe cards (for multi-card layout checks)
  - scheduled cards across multiple days (for move/copy drag checks)
- Disable fixture seeding for a specific browser session with query param:
  - `?mepFixture=0`
- Run deterministic Shift-drag telemetry capture:
  - `npx playwright test --config playwright.diagnostics.config.ts`
  - report output is printed as `[SHIFT_DRAG_DIAG]` JSON in test logs.

## 6) Preview/Recipe Performance Invariants

- Recipe preview/full views must prefer cached file content on open to avoid blank
  flashes between file switches.
- Loading indicators in the side preview should be deferred (short delay) so fast
  reads do not show flicker.
- Markdown image path resolution should use cache-first hydration before async
  resolution to avoid image-jump on initial render.
- Keep a bounded persisted hot-content cache (path + mtime keyed) so recently
  opened notes can load instantly across app restarts.
- Run idle-time prewarm with strict concurrency limits to avoid stealing
  interactivity from drag/drop or typing.
- Never run full-vault refresh scans for single-note create paths in interactive
  flows (drag/drop, quick add). Update in-memory indexes incrementally instead.

## 7) Runtime Verification Quirks

The served frontend must keep its security headers coherent with its resource needs: `scripts/start-web-host.mjs` sets a CSP (`SECURITY_HEADERS`) on every response, and any new fetch target (new API route, external image hosts already allowed via `img-src https:`) must fit inside it. A missing header is a silent regression — verify with `curl -I http://127.0.0.1:<port>/` after touching the server. Separately, thumbnail caches are content-addressed (`mep-core/src/thumbnails.rs`) with atomic temp-file-plus-rename writes keyed by source hash, so concurrent generation is safe; the cache root defaults to the host app-data dir's shared location (`XDG_DATA_HOME || ~/.local/share`, overridable with `--thumbnail-cache`).

## 8) Perceptual/Performance Release Gate

Perceptual budgets (recipe-grid readiness, scroll frame p95, severe-frame count,
visible-cover invariants) are enforced, not just measured. `npm run
test:diagnostics` (the three `tests/diagnostics/*.spec.ts` drag/generator
specs) runs in `scripts/pre-push.sh`; `npm run perf:release` (`benchmark:recipe-scroll`
checked against the committed thresholds in `scripts/release-budgets.json` via
`scripts/check-release-budgets.mjs`) runs in `scripts/preflight-release.sh`.
The benchmark aborts with exit code 2 and a clear message if the machine
is on battery (Discharging), since that condition produces false-red verdicts; on
intel_pstate systems powersave is the permanent default governor and does not imply
throttling on AC, so the meaningful signal is battery discharge, not governor name.
Pass `--allow-battery` or set `MEP_BENCHMARK_ALLOW_BATTERY=1` to override.
Budgets may only be raised in a dedicated commit carrying before/after
measurement evidence, never in the commit that consumes the new headroom (see
the governance comment at the top of `release-budgets.json`). This gate exists
because 2026-07-10 through 2026-07-19 shipped three green-gated regressions
(dead drag, broken dev images, gated covers) with no launched-app check
catching any of them before release.

Planner readiness (WeeklyOrganiserBoard's kanban board painting complete on
first mount, not empty-then-catching-up) is not carried by this harness or its
budgets: `benchmark-recipe-scroll.mjs`'s fixture (`generate-recipe-scroll-fixture.mjs`)
has no `scheduledDates` for the current week, so a planner nav never populates
any card regardless of code health, and wiring one in would mean maintaining
relative-to-"today" fixture dates plus a second navigate-and-poll code path in
a script that is otherwise entirely about the database grid — disproportionate
for one metric. The manual check: launch the app, land on Planner (the default
view), and confirm the week's scheduled recipes are present in the same frame
the board itself appears, not populating a beat after — the failure mode this
guards is the acd6d55e/81a8639c boot-deferral leaving `app.metadataCache`
empty for `WeeklyOrganiserBoard`'s first `rebuild()` while the deferred
recipesFolder/vault content read is still in flight. Normal startup verifies
current recipe metadata before readiness. Direct `/database` startup indexes
recipe files first, starts current metadata hydration after the database source
and current cover-store work reach owned terminal states, and render-gates
Planner on that hydration's explicit completion; a persisted snapshot is never
readiness authority. Immediate Planner navigation starts hydration directly.

## 9) Served-Surface Verification

`npm run perf:release` runs against a headless browser hitting the local web host over HTTP, which covers the same surface the product ships on, but it does not prove PWA installability or the served security-header baseline. Before a release boundary, boot the real host (`npm run host:web`) and confirm in an actual browser: the app loads and renders recipe-database covers, the browser offers the Enplace install (manifest + icons resolve), the installed app starts at `/` with the `/shopping` shortcut working, and `curl -I` shows the CSP/nosniff headers from `docs/security-baseline.md`. `scripts/preflight-release.sh` prints this manual checklist as its final step.
