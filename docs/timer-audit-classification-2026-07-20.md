# mise-en-place timer-audit classification

Audited at commit 73c0b61f with ~/development/ai/tooling/scripts/timer-audit.sh; verdicts are judgments against ~/development/AGENTS.md doctrine; re-run the script for current state.

Repo: mise-en-place working copy @ `73c0b61f` (main, freshly pulled, clean tree).
Audit: `timer-audit.sh` → 115 raw regex hits / 99 unique `file:line` locations, collapsed here into
28 distinct mechanisms ("sites"), since the regex fires once per token (type decls, `clearTimeout`
calls, test assertions, comments) rather than once per decision point. Doctrine: `~/development/AGENTS.md`.

## Summary (by site, 28 total)

| Verdict | Sites | Notes |
|---|---|---|
| REPLACE | 1 | in `App.tsx`, confirmed perf-neutral already (bead mise-en-place-rqm) |
| LOAD-BEARING | 4 | kanban-core cluster + 2 App.tsx UX timings + 1 write-coalescer |
| BOUNDARY | 17 | external processes, human input, platform API gaps, security TTLs, test/benchmark infra |
| NOISE | 5 (9 raw locations) | docs/config/already-correct cache headers; ~19 more raw lines are kanban-core test assertions folded into that LOAD-BEARING verdict, not counted separately |

## REPLACE

| Work item | Mechanism | LOC | Effort | Risk | Gate |
|---|---|---|---|---|---|
| **WI-2: metadataCache persist — WITHDRAWN (listener-coalescer retained)** (`src/App.tsx:989-1019`) | Census disproven at implementation (commit f5c59d63): the initial grep found exactly 3 producers; implementation revealed FIVE: the original 3 (`vault.refreshFolder()`/`vault.refresh()`, `vault.applyExternalChange()`) plus `Vault.modify()` (platform.ts:859-876) and `Vault.applyOptimisticContent()` (platform.ts:878-881), reachable via `FileManager.processFrontMatter`'s optimistic-write path (consumers: WeeklyOrganiserBoard.tsx drag schedule/unschedule ×4, field-manager.ts, RecipeIndexService.ts) and directly via `saveActiveFileContent`/`savePreviewFileContent` (App.tsx:2103-2120) and RecipeLogService.ts:81. With 5+ heterogeneous producers across modules, the generic `metadataCache.on("changed", scheduleFlush)` listener + coalesced flush is the simpler single definition versus threading completion calls and context through every producer. Do not re-attempt without first re-running the census and confirming the actual producer count has changed. | 0 (retained as-is) | N/A | Low — the listener + coalescer is the correct solution given the actual producer topology | N/A |
| **WI-1: `bumpVaultRevision` — drop the 250ms silence-coalescing timer** (`src/App.tsx:395-400`, call sites 890, 1220, 1785, 2396) | `bumpVaultRevision()` is called from 4 already-known-complete points: after `vault.refresh()` resolves (890); after the FS-watcher's own already-debounced `bump()`/`flushBump()` settles (1220, itself downstream of the 650ms burst-coalescer in WI-4 below — a second coalescing layer here is redundant); in the `finally` of clear-marked-items (1785); after `refreshFolder`/`refresh` resolves post-capture (2396). For 3 of these (1220, 1785, 2396) each is already a singular, already-settled completion — call `setVaultRevision` directly, no timer. Only the boot-time pair (the deferred recipesFolder reindex vs. the deferred `refreshVaultIndex()`, both landing "a beat apart" per the existing comment) genuinely needs coalescing; replace the blanket 250ms wall-clock wait with an explicit small pending-signals tracker scoped to the boot sequence so the two known producers coordinate directly instead of racing against silence. | roughly neutral to −10 (removes the general-purpose timer/ref; adds a small boot-scoped counter) | M | Low-medium — bounded to vaultRevision plumbing, well covered by the existing suite; the current in-code comment's account of "the watcher's bump()" wiring didn't fully match what a read of the current vault-watcher effect shows (that effect explicitly does *not* wire `metadataCache` "changed" to `bump()` — see its own comment at `App.tsx:1280-1286`), so pin down the actual second boot-time producer by tracing before editing, rather than trusting the comment as-is | same as WI-2 — full unit + smoke suite; already proven perf-neutral (bead mise-en-place-rqm) |

**Recommended tranche order**: WI-2 first (smallest, cleanest, all 3 producers already verified), WI-1 second (needs a short trace first to pin the real second boot-time producer (the existing code comment doesn't fully match current wiring).

## LOAD-BEARING (flag only, no blind replacement)

- **kanban-core timing cluster**: `click-gate.ts` (`clickBlockMs=500`, `dragCooldownMs=300`), `click-intent.ts` (`modifierGraceMs=250`, `intentWindowMs=1200`), `refresh-scheduler.ts` (`refreshDelayMs`), consumed by `useKanbanBoard.ts`/`WeeklyOrganiserBoard.tsx`, exercised by `click-gate.test.ts`/`refresh-scheduler.test.ts`. Documented, contract-canonical defaults disambiguating a genuine click from a drag-library's trailing synthetic click. Doctrine's own example.
- **App.tsx notice auto-dismiss** (4000ms, line 1172) — toast UX duration.
- **App.tsx preview-loading spinner delay** (120ms, line 2137) — deliberate anti-flicker threshold so fast local reads never flash a spinner.
- **App.tsx persisted-content-cache write-coalescer** (240ms, lines 610-634) — batches a continuous, unbounded prewarm-read stream (one file read roughly every 70-650ms, no natural "batch end") against a synchronous `localStorage.setItem`. Unlike WI-1/WI-2, the producer here has no discrete completion boundary to hook — replacement would need its own measured case.

## BOUNDARY (grouped)

- **App.tsx vault-watcher FS-burst coalescer** (650ms debounce + 1200ms min-interval + 180/120ms fallback-refresh scheduling, lines 1211-1254, 1343-1344) — external multi-file edit bursts from editors/sync tools; no completion signal exists from that external side.
- **Periodic backstop polls**: App.tsx 5min(Tauri)/60s(browser) full-vault-refresh interval (1336); App.tsx 5min inbox rescan interval (1384) — defense-in-depth alongside the real event listeners (native FS watcher, vault "create"/"modify"), guarding against a silently missed event, which is the exact failure mode being guarded against and thus has no knowledge-driven substitute.
- **App.tsx startup elapsed-seconds ticker** (1s interval, line 799) — wall-clock display; no event exists for "a second passed."
- **`requestIdleCallback`-with-`setTimeout`-fallback** (App.tsx 904 → 300ms, App.tsx 2046 → 70ms, WeeklyOrganiserBoard.tsx 599 → 250ms) — platform API gap, not all browsers/webviews implement `requestIdleCallback`.
- **InboxWatcher.ts `DEBOUNCE_MS=500`** (lines 11-99) — investigated per the task's flag: confirmed via `src-tauri/src/main.rs:1239` that the `notify` crate's `EventKind::Modify(_)` is collapsed into one generic `"modify"` cross-platform before it ever reaches TypeScript — no close-write/completion signal is exposed. The true producer (an external share-sheet/curl/sync client dropping files into the inbox) can't announce "done." Genuine boundary, not the same class as WI-1/WI-2.
- **Human-typing debounces**: CookingDatabase.tsx `SEARCH_DEBOUNCE_MS=120`, RecipeView.tsx `AUTOSAVE_DEBOUNCE_MS=350` — canonical doctrine exception (producer is a person typing).
- **LedgerStore.ts exponential backoff retry** (lines 96-119) — IO/persist retry boundary.
- **RecipeParser.ts `rateLimit`/`MIN_DELAY_MS=2000` + `fetchWithTimeout` `AbortController`** (lines 264-294) — outbound scraping of third-party recipe pages; rate-limit and timeout at a genuine cross-process boundary with no channel.
- **nuke-start.sh `sleep 1`** (line 12) — settle buffer after `pkill` before deleting files those processes may still hold open.
- **mep-cli `browser.rs` `waitForTimeout(2000)`** (line 41) — Playwright waiting on an arbitrary external webpage's client-side JS; no completion channel.
- **benchmark-recipe-scroll.mjs `withTimeout` + child-process SIGKILL escalation** (lines 61, 159) — the benchmark harness IS the measurement; the SIGKILL timer is a fallback after a real `child.once("exit", ...)` listener, not a substitute for it.
- **tests/visual-stability.spec.ts `waitForTerminalImageState`** (line 104) — already event-driven (`load`/`error` listeners); the 5000ms timer is a pure failure backstop, doctrine-compliant as written.
- **start-web-host.mjs thumbnail auth cookie `Max-Age=3600`** (line 380) — auth/session expiry, a security TTL, not a knowledge gap.

## NOISE (count only)

9 raw locations: `CHANGELOG.md:59` (changelog prose), `scripts/release-budgets.json:2` (governance string), `App.tsx:422` (comment describing a boolean settled-state gate, not a literal timer), `vite.config.ts:58` (dev-server explicit `no-store`, the opposite of a TTL guess), `scripts/start-web-host.mjs:179,1312` (immutable, content-addressed asset/thumbnail cache headers — already the doctrine-recommended content-addressing pattern), `scripts/start-web-host.test.mjs:121,738` (test assertions of those headers). A further ~19 raw lines in `click-gate.test.ts`/`refresh-scheduler.test.ts` are test assertions of the kanban-core LOAD-BEARING constants — folded into that verdict as benchmark/contract coverage rather than counted separately here.

## Recommended tranche order

1. **WI-1** (bumpVaultRevision 250ms cleanup) — completed in commit f5c59d63.
2. **WI-2** (metadataCache 500ms persistence) — withdrawn at implementation (commit f5c59d63); producer census disproven; listener-coalescer retained as the simpler solution for 5+ heterogeneous producers across modules.
3. No other REPLACE candidates identified in this sweep — everything else is BOUNDARY, LOAD-BEARING, or NOISE and does not warrant a work item without its own measured case (per doctrine's measurement-gate rule).
