# kanban-core adapter guide

Use `createBoardPatcher` for refresh reconciliation and `createAdoptKanbanCore` for a server-rendered interactive board. The core does not own initial rendering.

## MEP build mode

MEP renders jKanban DOM first, then creates a patcher with `JKANBAN_SELECTORS` and `buildJKanbanCardElement` from `useKanbanBoard.ts`. `KanbanCardData` carries trusted HTML and consumer classes while the selector preset owns structural classes. `snapshotFromDom()` immediately after the jKanban build makes the first unchanged refresh a no-op.

```ts
const patcher = createBoardPatcher({
  container: containerEl,
  selectors: JKANBAN_SELECTORS,
  buildCardElement: buildJKanbanCardElement,
  onLanesRendered,
});

patcher.snapshotFromDom();
```

Pass only existing lane ids to `patchLanes()`, and include both source and target lanes for a cross-lane move. When a drop changes the id encoded on a moved or copied node, call `rekeyCard(element, newId)` with the exact Dragula element before the next patch.

MEP's existing `settleExternalDrop()` use remains valid. Its `onMove` returning `void` means `confirmed`; callers that need the result may await the returned `SettlementResult`.

## SSR adopt mode

An SSR consumer passes no card builder. It emits all card markup itself, adopts the rendered root, and routes every movement input through one core method.

```ts
const core = createAdoptKanbanCore({
  selectors: TRAINING_SELECTORS,
  source: {
    onMove: (move) => api.applyMove(move),
    onMoveError: (error, move) => reportMoveFailure(error, move),
  },
  onSettled: (result, move) => showMoveStatus(result, move),
});

core.adopt(rootEl);

function onPointerDragStart(cardId: string) {
  core.beginDrag(cardId);
}

function onPointerDrop(cardId: string, targetLaneId: string, index: number) {
  return core.handleDrop({ cardId, targetLaneId, index });
}

function onKeyboardMove(cardId: string, targetLaneId: string, index: number) {
  return core.handleDrop({ cardId, targetLaneId, index });
}
```

Call `cancelDrag()` when a pointer drag is abandoned. The coordinator restores a Dragula-pre-moved card before queueing it behind an outstanding settlement, so the active move is the only visible optimistic mutation. A root replacement must call `adopt(newRoot)` after inserting fresh markup. The coordinator keeps its settlement queue, version-fences old work, and suppresses stale completion reporting. An indeterminate result blocks further drops until that fresh adoption; the new root stays server truth because no indeterminate order is cached.

## Required tests for an adopt consumer

- Assert that its patcher options omit `buildCardElement`; test existing-card reorder and cross-lane movement without node construction or cloning.
- Assert that a missing or signature-changed card fails before any DOM mutation and includes the exact card id.
- Cover first, middle, last, and same-lane indexes, plus invalid-index rejection.
- Cover confirmed, rejected, and indeterminate settlement, including exact rejected rollback and no indeterminate cache.
- Cover overlapping distinct drops, reverse resolver attempts, duplicate coalescing, and an `onMoveError` that throws.
- Replace the root during an in-flight move and prove old/new roots remain serialized, stale completion is indeterminate without `onSettled`, and an indeterminate move blocks its generation until fresh adoption.
