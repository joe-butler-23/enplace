# Independent review — Database→Planner candidate `9a8ea6790745f442e45bfdc39cc04d48d1a1d3e5`

Date: 2026-08-13 (read-only review)

## Verdict

**Do not accept this as the final candidate yet.** The paired resident transition is fast and the supplied raw timing evidence is internally coherent, but the implementation has correctness gaps outside that narrow precondition. In particular, direct startup on the Planner can render a partial recipe-only board before authoritative full-vault refresh, and a refresh failure on that route is not surfaced with a retry. The embedded remote path can remain permanently blocked. The supplied early certificate also does not exercise the claimed press-time promotion: in all three samples the dataset was already ready before the press.

No repository files were edited and no commits were made. The repository was clean after review.

## Scope and source

- Repository: local `mep-planner-transition-benchmark` working copy
- `AGENTS.md` read before review.
- Reviewed `e1fb516..9a8ea6790745f442e45bfdc39cc04d48d1a1d3e5`, especially `src/App.tsx`, metadata hydration, planner navigation/identity, refresh priority, the board's ready callback, and the benchmark collector.
- Also reviewed the three supplied evidence locations under `/tmp`.

## Findings

### F1 — Direct Planner startup can show partial/stale data before authoritative readiness (high)

`plannerBoardReady` correctly requires both `plannerDatasetReady` and a board identity (`src/App.tsx:462-465`), and pending navigation settlement uses it (`:955-971`). However, the actual board render at `:3149-3185` is gated only by `plannerMetadataStatus.status === "ready"`, not `plannerDatasetReady`.

On the normal native/default web route the initial view is Planner. `deferRecipeMetadata` is false (`:1159-1164`), so `indexFolder(recipesFolder)` and its metadata hydration can complete while the vault still contains only the recipe-folder index. Runtime then renders the board while `plannerDatasetReady` is still false; full `vault.refresh()` is only idle/300-ms scheduled (`:1261-1274`). The board's synchronous `buildBoardEntries` therefore has a window in which planner-folder tasks/reminders are absent. `onBoardReady` can publish an identity for that partial board even though the semantic evidence effect correctly refuses to mark it until the dataset flag is true.

If that background refresh fails on this direct route, `setPlannerDatasetFailure` is set (`:1249`) but `pendingPlannerFailure` is only rendered for a pending navigation (`:459-460`, `:3114-3124`). There is no visible retry while the initial active view is already Planner. This is a real stale/partial-data and failure-recovery gap that the database-to-Planner benchmark does not cover.

### F2 — Embedded remote database startup can deadlock in metadata waiting (high, assuming embedded mode is supported)

The code has an explicit embedded mode (`notifyEmbeddedReady` and the `window.parent !== window` effect), but the candidate's remote database path does this:

1. `deferRecipeMetadata` is true and sets `plannerMetadataBlockedByVaultRefreshRef` plus `deferredVaultRefreshRef` (`:1277-1279`).
2. `startPlannerMetadataHydration` consumes the deferred callback and returns without starting metadata (`:772-777`).
3. `queueVaultRefresh` only registers/starts refresh inside `if (window.parent === window)` (`:1261-1275`).

For an embedded remote window, the callback is consumed but no refresh starts; the blocked flag remains true and metadata remains `waiting`. Subsequent calls see a null deferred callback and return. There is no parent-message handler in this repository that supplies the missing refresh. The result is a Planner that can remain stuck indefinitely rather than reaching authoritative readiness. If embedded mode is intentionally unsupported for this surface, that contract needs to be explicit; as written, the code advertises embedded readiness and does not preserve web parity.

### F3 — Failure mark is not tied to a navigation generation; the failure certificate proves a different path (medium/high)

In the refresh catch (`src/App.tsx:1243-1258`), `mep:planner:navigation-failed` is emitted whenever the current initialization generation matches, even if there is no pending Planner intent. Its `generation` is `plannerNavigationIntentRef.current.pending?.generation`, which is undefined when the background startup refresh fails before a click.

The supplied failure samples demonstrate this exactly: in each sample `mep:vault:refresh-failed` and `mep:planner:navigation-failed` occur before the first Planner `pointerdown` (e.g. sample 1: failure mark at 348.7, first pointerdown at 444.8), and the failure mark detail contains only `message`, no generation. The first click therefore observes an already-existing `plannerDatasetFailure`; it does not cause the marked failure. The retry later succeeds and produces the expected board, but this does not certify failure-after-navigation, generation fencing, or retry of a pending intent.

The failure JSON also declares precondition `database-exact+planner-dataset-ready`, while `runSample` explicitly waits only for database readiness when `failureRetry` is true (`scripts/benchmark-planner-transition.mjs:387-397`). That is a provenance/contract mismatch.

### F4 — Retry has no in-flight ownership; duplicate retry can re-fail a successful retry (medium)

`retryVaultRefreshRef` stores the bare `refreshVaultIndex` function (`:1217-1219`). There is no in-flight guard or generation token for retries. Two rapid `Retry planner data` activations can start concurrent `app.vault.refresh()` calls. `Vault.refresh()` advances its own index generation; one call can reject as superseded while the other succeeds. Both callbacks still belong to the same App initialization generation, so the losing catch can set `plannerDatasetFailure` and fail the current intent after the winning refresh has marked the dataset ready. This can leave the user with a spurious retry error. The unit tests cover metadata-generation fencing, but not duplicate refresh/retry ownership.

### F5 — Cancellation and lifecycle fences do not cover refresh priority (medium)

- `cancelPendingPlannerNavigation` (`:825-829`) cancels the intent but does not reset `plannerRefreshPriorityRef`. If a user presses Planner and then leaves before the deferred refresh is registered, the stale priority still promotes that refresh when it is later registered. This is work retained from a cancelled intent, contrary to the “explicit Planner intent promotes” comment.
- The component unmount cleanup increments `initializeGenerationRef` and clears deferred refs (`:1300-1305`) but does not call `resetPlannerRefreshPriority`. An already scheduled idle/300-ms callback can therefore invoke the old `refreshVaultIndex` after unmount. Its later state writes are generation-fenced, but the full filesystem refresh itself is not cancelled.
- `popstate` returns early when the route equals `activeViewRef.current` (`:934-940`), without cancelling an outstanding pending Planner intent. A same-path history/popstate event while a Planner request is pending can later be followed by `settlePlannerNavigation` and an unexpected Planner activation. This deserves an explicit regression test.

### F6 — Initialization generation fences only refresh completion, not initialization itself (high)

`initializeGenerationRef` is checked around the background `vault.refresh()` callbacks, but the asynchronous initialization pipeline has no equivalent ownership checks after its awaits. A concrete route is switching vaults (or otherwise starting a second `initialize`) while the first one is still in `loadSettings`/`createStandaloneApp`/`Promise.all`: the old pipeline can later assign `plannerMetadataRef.current`, call `setRuntime`, `setSettingsRevision`, `setDatabaseState`, and queue its old app's refresh after the newer generation has started. The old refresh's state writes are fenced, but the old runtime and metadata assignments are not. This can pair the new settings with an old vault/runtime or let stale metadata become current. The reset in `initialize` (`:1096-1114`) does not cancel/fence all old continuations.

### F7 — Board construction failure has no failure channel, so a pending navigation can wait forever (medium)

`useKanbanBoard` catches initialization failures and only logs them (`src/modules/organiser/hooks/useKanbanBoard.ts:802-804`). With the candidate's new requirement that navigation waits for `plannerBoardIdentity`, no `onBoardReady` callback follows a build failure. The pending intent remains neither failed nor retryable and no deadline/error surface exists. The previous dataset-only gate did not have this particular deadlock because it could settle before board construction. A board-ready failure callback or an explicit error/abort path is needed if identity is authoritative navigation readiness.

## Evidence audit

### What passes

I parsed every candidate sample in the five paired candidate files and all three early samples:

- Paired candidate click-to-presentation: **27.9–39.5 ms** (all <= 50).
- Paired candidate pointerdown-to-presentation: **113.5–123.5 ms** (all <= 130).
- Early candidate click-to-presentation: **27.5–28.7 ms** (all <= 50).
- Early candidate pointerdown-to-presentation: **112.7–113.0 ms** (all <= 130).
- Candidate raw `elements` contain exactly one post-click week-range Element Timing entry and one post-click anchor entry per sample; `renderTime` is the authority used by `deriveTransitionSample`, not a synthetic mark.
- Candidate paired samples have no placeholder Element Timing entries, no early planner shell, no console errors, no network errors, and post-window lane/card identity exactly matches the expected fixture.
- All five controls fail for the expected exact `mep:planner-placeholder:suspense` negative. Their post-window board identity is correct, so the negative is specifically the control's Suspense presentation rather than a random fixture failure.
- Failure samples have the expected EACCES failure, one retry semantic identity, no placeholder, exact post-window identity, no network errors, and only one 500 console message (the evaluator filters this expected fixture response in failure mode).

There is no indication that the candidate paired Element Timing was fabricated: the raw buffered entries carry actual target identifiers and `renderTime` values (e.g. 708 ms), while the semantic-ready mark precedes them (e.g. 687.7 ms). The benchmark's post-window DOM identity check also catches a wrong/partial board after the endpoint.

### Evidence gaps / caveats

- The “early” certificate does **not** exercise early press promotion. Dataset-ready occurs before the pointer in all three samples (sample 1: dataset 488.8 vs pointer 555.1; sample 2: 475.6 vs 539.3; sample 3: 494.5 vs 567.0). The first database thumbnail tranche can itself call `startPlannerMetadataHydration` (`App.tsx:2449-2451`), so the deferred refresh was already started by the time the press happened. A true early sample must press while the refresh is still pending and prove the press causes promotion.
- The failure certificate's declared precondition is wrong as described in F3, and its first failure mark is pre-click; it is not a pending-navigation failure/retry certificate.
- The evaluator filters *any* console message matching `Failed to load resource: the server responded with a status of 500` in failure mode (`benchmark-planner-transition.mjs:342-345`). The supplied raw samples show one expected 500, but this broad filter could hide an unrelated 500 in another fixture.
- Paired controls identify git head `f72c19b7199d8705100e552d0b9c24c6f0185205`, not the stated production baseline `bf71565`; they are valid expected-Suspense controls for this evidence set, but should not be described as direct bf71565 proof.

## Timer-inference review

Ran `~/development/ai/tooling/scripts/timer-audit.sh ... --json` (exit 0). The changed `requestIdleCallback(..., { timeout: 2000 })` / `setTimeout(..., 300)` is a legitimate background scheduling/platform fallback, not a readiness inference; the completion signal remains `vault.refresh().then/catch`. The priority module's generation check fences stale scheduled callbacks after `initialize` (`resetPlannerRefreshPriority`), and its focused test passes. However, the unmount cleanup omission in F5 leaves the scheduled callback unfenced on teardown. Existing 50-ms Kanban batching, 1-s startup elapsed display, and other unrelated timers were classified as batching/display or existing boundary contracts; no new polling-as-readiness defect was found.

## Checks run

All read-only checks passed:

- `npm test -- --run src/standalone/metadata-hydration.test.ts src/standalone/planner-refresh-priority.test.ts src/standalone/planner-navigation-intent.test.ts src/standalone/planner-transition-evidence.test.ts`: **19/19**.
- `node --test scripts/benchmark-planner-transition.node-test.mjs`: **9/9**.
- `npm run typecheck`: passed.
- `npm run build:web`: passed (existing large-chunk warning only).
- `timer-audit.sh ... --json`: exit 0; findings reviewed above.


---

# Correction review — candidate `1d298497aeb911a3de7652652fb085862612f12d`

Review date: 2026-08-13, read-only. This section supersedes the original F1–F7 verdict for the corrected tree where noted.

## Correction verdict: HOLD certification, not an implementation rejection

The current diff addresses the original high findings substantially:

- **F1 direct partial Planner:** board rendering now requires both `plannerDatasetReady` and ready metadata (`src/App.tsx:3181-3207`). The supplied direct/embedded smoke observation (dataset mark 313.1 ms, first board DOM 314.7 ms, mixed task present, no final loading/error) supports this gate.
- **F2 embedded deadlock:** the deferred callback/`window.parent === window` guard was removed; `queueVaultRefresh()` is now always registered, so embedded remote can start the authoritative refresh.
- **F3 pre-click failure:** the failure harness holds the real idle callback, and the current code emits a generated failure mark only for a pending intent. The supplied failure raw samples show `pointerdown` at 340.3/329.8/358.7 ms, `mep:vault:refresh-failed` at 379.1/366.6/396.3 ms, and generated `mep:planner:navigation-failed` at 427.6/416.0/445.2 ms with generation 1. This is now post-pointer and generation-bearing.
- **F4 duplicate retry:** `vaultRefreshInFlight` is now single-flight and cleared in `finally` (`:1259-1315`).
- **F6 initialization fencing:** the main asynchronous initialization awaits now check `isCurrentInitialization`, stale metadata is cancelled, and stale `finally`/catch paths no longer mutate current UI (`:1121-1347`).
- **F7 board failure:** `onBoardError` is threaded through the board/kanban hook and retries remount the board using `plannerBoardRetryRevision` (`:859-872`, `:3224-3241`).
- Same-route popstate cancellation for non-Planner routes is now explicitly handled (`:953-960`), and unmount resets refresh priority (`:1353-1360`).

### Remaining exact defect C1 — cancellation mutates priority but does not fence the scheduled callback (medium)

`cancelPendingPlannerNavigation` sets `plannerRefreshPriorityRef.current.prioritized = false` (`src/App.tsx:829-834`) but does not clear `pendingStart` or increment its generation. `registerPlannerRefreshStart`'s returned `startOnce` does not test `state.prioritized`; it only tests its private `started` bit and `state.generation` (`src/standalone/planner-refresh-priority.ts:17-27`). Therefore this exact sequence still starts work after cancellation:

```ts
const state = createPlannerRefreshPriorityState();
let starts = 0;
const scheduled = registerPlannerRefreshStart(state, () => { starts += 1; });
state.prioritized = false; // exactly what App cancellation does
scheduled();
// starts === 1, despite cancellation
```

The refresh may already be in flight for the ordinary mouse path (priority is promoted during the same request), but the helper/API contract still permits a cancelled scheduled callback to launch work. This is especially reachable around an externally delivered navigation/history cancellation or a registration/request race. Cancellation should reset/fence the generation (or `startOnce` should require active priority) rather than merely mutate a boolean.

### Remaining exact contract/evidence defect C2 — supplied “current” certification is not for current HEAD (high for release proof)

All three supplied JSON files report:

```text
gitHead = 9a8ea6790745f442e45bfdc39cc04d48d1a1d3e5
```

but the candidate under review is `1d298497aeb911a3de7652652fb085862612f12d` (commit timestamp 11:39; artifacts were created around 10:32–10:35). The corrected tree changes both application gating/refresh ownership and benchmark failure scheduling/derivation after 9a8. Thus these files cannot be immutable certification evidence for HEAD 1d298. The failure artifact's generation-bearing details are consistent with the corrected uncommitted code, but its recorded provenance still points to the prior commit. Additionally, consolidated-primary contains a `mep:planner:refresh-registered` mark, while `git grep` of HEAD 1d298 contains no producer for that mark; this is further proof that the artifact was collected from an instrumented/uncommitted tree rather than the reviewed commit. The older paired controls likewise point to `f72c19b`, not the stated production baseline `bf71565`.

The direct/embedded smoke observation is useful supplemental evidence, but it is not a durable raw certification artifact with the candidate HEAD. Re-run early, primary, failure, and paired control certification with `git rev-parse HEAD` equal to 1d298 before accepting the release boundary.

### Remaining contract concern C3 — full refresh is silently scheduled during Database startup

The corrected code sets `plannerMetadataBlockedByVaultRefreshRef.current = true` for remote Database startup (`:1331-1334`) but then immediately calls `queueVaultRefresh()` unconditionally (`:1334`). The idle/300-ms callback therefore starts the full-vault refresh even if the user never expresses Planner intent. This is visible in the supplied consolidated-primary raw marks: refresh is complete at ~263–271 ms, while database semantic-ready is ~342–354 ms and the later Planner press occurs ~431–443 ms. The comment says explicit Planner intent promotes an already-owned refresh, but ordinary scheduling has already launched it before the press. If the intended contract is “Database foreground work remains uncontended and Planner press owns promotion,” this silently shifts the expensive refresh into Database startup; either document/accept that preload or restore an explicit ownership condition. The failure harness's idle override intentionally masks this scheduling in its one scenario.

## Updated evidence checks

- Simplified early: all 3 passed; click-to-presentation **28.7–32.5 ms**, pointerdown-to-presentation **110.8–116.1 ms**; no console/network/loading errors or placeholders.
- Consolidated primary: all 3 passed; click **28.4–35.0 ms**, pointer **110.0–121.3 ms**; no console/network/loading errors or placeholders.
- Simplified failure: all 3 passed derived failure/retry identity checks; each has one expected 500 console message, post-pointer EACCES failure, generation 1, and final exact board identity.
- Element Timing remains plausible: target entries are actual buffered `elements` with exact render times and no placeholder entries; post-window lane/card identity is exact. The broad one-500 filter remains weaker than URL-specific proof, but the raw samples show only that one expected message.
- The artifacts' sample values satisfy the requested click <=50 and pointer <=130 budgets wherever a normal/early transition is derived.

## Updated checks run on HEAD 1d298

- Focused Vitest: **19/19**.
- Benchmark node tests: **9/9**.
- `npm run typecheck`: passed.
- Current timer audit: exit 0. Idle/300-ms scheduling is a legitimate bounded background scheduling contract, not readiness inference; the remaining concern is silent Database-startup ownership (C3), not a polling defect.

**Bottom line:** the original stale/partial, embedded-deadlock, pre-click-failure, duplicate-refresh, initialization-fence, and board-error findings are corrected in code. I cannot issue ACCEPT for the candidate as a release-certified result because C1 remains an exact cancellation/fencing defect and, independently, the supplied certification JSON is provenance-stale relative to HEAD 1d298. Re-run certification on 1d298 and fence the canceled priority callback before acceptance.


---

# Final correction review — candidate `73f7a1a8cdc9b592150f4051fe49319849a40f4a`

## Verdict: ACCEPT

Reviewed only `1d29849..HEAD` and the exact supplied artifacts:

- `/tmp/mep-planner-transition-73f7a1a-early-3.json`
- `/tmp/mep-planner-transition-73f7a1a-failure-3.json`
- `/tmp/mep-planner-transition-73f7a1a-paired-certification/`

The prior HOLD reasons are resolved or intentionally dispositioned:

- The refresh is explicitly app-owned background work required to prepare the resident Planner; navigation cancellation does not cancel that shared work. The current comment in `App.tsx` documents this ownership contract. The pre-press refresh seen in normal/early evidence is therefore intentional rather than silently shifted work.
- All supplied artifacts bind the exact candidate HEAD `73f7a1a8cdc9b592150f4051fe49319849a40f4a`. Controls are separately identified as the expected `f72c19b` control arm.
- Failure precondition provenance is now `database-exact`, matching the harness.
- Latency budgets are now binding in `evaluateCollectedSample`, with a regression test proving samples over either budget fail.

### Raw evidence verification

- **Five candidate pairs:** all passed. Click-to-presentation values are **28.5, 33.6, 36.5, 29.9, 32.4 ms**; pointerdown-to-presentation values are **117.6, 118.9, 121.0, 113.9, 117.0 ms**. Every sample is within click <=50 and pointer <=130.
- **Three early samples:** all passed. Click values are **28.7–31.7 ms**; pointerdown values are **112.6–116.7 ms**. Every sample is within both budgets.
- **Five controls:** each is an expected exact negative with failure `planner placeholder exactly presented: mep:planner-placeholder:suspense`; raw Element Timing contains that exact Suspense placeholder and no unrelated console/network failure.
- **Three failure/retry samples:** each has trusted pointer/click input, real post-pointer EACCES refresh failure, navigation failure generation 1, successful retry semantic identity, no final placeholders, exact final board identity, no network errors, and no final loading/error surface. The sole 500 console message is the expected fixture response and is accepted only when it is the single console error.
- Candidate paired/early raw entries contain one exact post-click week-range and anchor Element Timing entry each, no planner placeholder, no early planner shell, and exact post-window lane/card identity. The timing authority remains actual buffered Element Timing `renderTime`; semantic marks are not used as presentation substitutes.

The direct+embedded isolated smoke also showed the authoritative dataset mark at 313.1 ms before first board DOM at 314.7 ms, with a mixed task present and no final error/loading surface, consistent with the corrected dataset gate.

No remaining high-severity correctness defect was found in the exact diff. Focused/read-only checks previously passed (19 Vitest tests, 9 benchmark node tests, typecheck, and timer audit). Final verdict to parent: **ACCEPT**.
