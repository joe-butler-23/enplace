# kanban-core contract

`src/kanban-core` is a framework-neutral interaction layer. It owns card movement mechanics, three-way settlement, DOM patching, and adopt-mode reconciliation. It never renders an initial board.

`src/kanban-component/client.ts` is the client-rendered component entrypoint. It composes the patched jKanban renderer, Dragula, delegated interaction lifecycle, and node-preserving patcher behind `createKanbanClient()`. `KanbanBoardData.titleHtml` and `KanbanCardData.html` are trusted HTML; consumers must escape note-controlled text and attributes before passing them in.

## Markup and selectors

The default `CONTRACT_SELECTORS` use `data-kanban-lane` for lanes, `data-kanban-cards` for a lane's direct-card container, and `data-kanban-card` for cards. Consumers with established markup pass a `KanbanSelectorMap`; MEP's jKanban markup uses `JKANBAN_SELECTORS`.

Cards must be direct children of their lane's cards container. Movement indexes are zero-based over those direct card elements after excluding the moving card.

## Patcher modes

`createBoardPatcher({ container, selectors?, buildCardElement?, onLanesRendered? })` reconciles partial `KanbanLanePatch[]` card data with an existing static lane topology. Empty ids, unknown lanes, duplicate lane ids, and duplicate card ids are contract errors; a partial patch cannot introduce a card retained by an untouched lane. Adding, removing, or renaming lanes requires a fresh render.

Build mode passes `buildCardElement`. The builder constructs missing cards. When an existing card's HTML or classes change, build mode updates that node in place and preserves its identity.

Adopt-mode patching omits `buildCardElement`. It can remove, reorder, and move an existing card across lanes without constructing or cloning a node. Before any mutation, it preflights every changed lane. If a requested card is missing or its signature differs, it throws `Kanban patch requires buildCardElement for card "<id>"`; the exact card id identifies the first unsatisfied requirement and no earlier lane is mutated.

`snapshotFromDom()` records structured card order and presentation state from an already-rendered board with zero mutation, making an unchanged first patch perform no DOM query or mutation. `rekeyCard(element, newId)` changes the exact moved or copied element; a Dragula clone can therefore never rename its source card.

`invalidateLanes(laneIds)` marks lanes whose DOM was moved outside the patcher. The next patch containing those lanes reconciles them against authoritative data even when that data matches the cached state; successfully reconciled invalidations are consumed. Other unchanged lanes retain the zero-DOM-query fast path. `createKanbanClient()` exposes the same method and invalidates the source and target lanes before forwarding each Dragula drop.

## Move and settlement values

```ts
type KanbanMove = {
  cardId: string;
  sourceLaneId: string;
  targetLaneId: string;
  index: number;
  sourceOrder: string[];
  targetOrder: string[];
};

type SettlementResult = "confirmed" | "rejected" | "indeterminate";
type MoveSettlementOutcome = void | "indeterminate";
```

`void` from `onMove` remains `confirmed`, preserving MEP's build-mode contract. An `onMove` rejection is `rejected`; an explicit `"indeterminate"` means the backing outcome could not be verified. `settleExternalDrop()` returns the final `SettlementResult` and retains its existing optional `onSettled` callback.

Reusable lifecycle `onDrop` callbacks may return `void` or `Promise<void>`. Synchronous throws and promise rejections are reported through `onDropError(error, move)` without escaping the Dragula listener; when that callback is absent, the lifecycle reports the failure to the console.

## Adopt coordinator

Adopt-mode consumers use the exported coordinator:

```ts
const core = createAdoptKanbanCore({
  selectors,
  source: {
    onMove: async (move) => api.move(move),
    onMoveError: (error, move) => reportMoveFailure(error, move),
  },
  onSettled: (result, move) => updatePresentation(result, move),
});

core.adopt(root);
core.beginDrag(cardId);
const result = await core.handleDrop({ cardId, targetLaneId, index });
core.cancelDrag();
core.destroy();
```

`beginDrag()` captures the pre-drag source order so pointer libraries may move a node before their drop callback. `handleDrop()` restores that pre-moved card before queueing it, then validates the requested post-exclusion index and performs the optimistic insertion when its turn begins. Keyboard controls call the same `handleDrop()` method directly; they do not maintain a second optimistic path. Distinct drops settle in request order; an identical pending root/version/card/target/index request returns the same promise and submits one move.

The coordinator owns one settlement queue across root generations. A confirmed move caches the resulting source and target orders. A rejected move restores the exact captured orders before reporting `rejected`. An indeterminate move leaves the optimistic DOM visible, does not cache it, and blocks further drops for that root generation until fresh server markup is adopted. Queued work from an older adopted root is fenced before it can mutate the current root or call `onMove`; an in-flight old-root completion resolves `indeterminate` and never calls `onSettled`.

`adopt(newRoot)` treats the new server-rendered root and its lane membership as authoritative. It only reapplies a cached confirmed order among the fresh-server slots occupied by cards still in that lane cache; cards absent from that cache remain anchored in server order, and no card moves between fresh server lanes. An old in-flight move is versioned to the root it started on, so its completion cannot mutate or cache against a newer adopted root.

## Distribution boundary

The core has no React, platform, vendor, or organiser-module imports. `npm run build:kanban-core` emits the minimal adopt coordinator only (`src/kanban-core/adopt-entry.ts`) as one dependency-free ESM vendor file in `dist-kanban-core/`, with the package version and current source state in its banner. Build-mode consumers continue to import the complete internal API from `src/kanban-core/index.ts`.

`npm run build:kanban-client` emits the separate dependency-free client renderer and structural CSS in `dist-kanban-client/`. Its provenance records the exact commit, dirty state, byte count, and SHA-256 digest of both artifacts. The client validates all lane and card identities before replacing an existing render. The client output bundles the patched jKanban renderer and Dragula; the core output does not.
