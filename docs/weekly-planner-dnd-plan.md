# Weekly Planner DnD Plan

Status: Active (Phase 0-1 implemented, Phase 2 schema alignment ongoing)  
Last updated: 2026-02-12

This plan defines how weekly planner drag-and-drop is being made deterministic,
generator-friendly, and fast without introducing duplicate-note behavior.

Implementation note (2026-02-12):
- Drag intent is now resolved once at drag start and reused through drop/commit.
- Shift-copy uses the same jKanban/dragula copy path as ordinary card copies.
- Reminder delete-on-marked is active via DnD.

## Problem Summary

- Current shift-drag behavior is inconsistent between immediate UI and persisted
  result.
- Some drop updates only appear after manual refresh.
- We want generator-style copy semantics (source remains) with strong
  performance and predictable persistence.
- We should reuse proven patterns from existing drag-and-drop systems instead of
  inventing custom behavior.

## Constraints (Current Stack)

- Weekly planner UI uses jKanban + dragula event callbacks.
- Planner currently attempts multi-date scheduling on a single note.

### Hard External Constraint: PTT Frontmatter Schema

- `ptt-core` currently models `scheduled` as a scalar string:
  - `ptt/core/src/types.rs` (`scheduled: Option<String>`)
- `ptt-core` recipe database view also reads `scheduled` as a single value:
  - `ptt/core/src/views/mep.rs`
- Conclusion: writing `scheduled` as a YAML array is not a safe contract until
  PTT schema/parser/view are updated.

## Existing Approaches Reviewed

### 1) Dragula Copy Semantics (Current Foundation)

- Dragula has first-class copy behavior via `options.copy` and
  `options.copySortSource`.
- Behavior differences for move vs copy are explicit in dragula docs.
- This maps well to generator-style interactions when copy intent is resolved
  once per drag and reused by persistence logic.

Primary source:
- https://github.com/bevacqua/dragula

### 2) jKanban Event Surface

- jKanban exposes `dragEl`, `dragendEl`, and `dropEl` callbacks and uses
  dragula internally.
- jKanban does not expose a complete high-level "copy + domain intent" API, so
  app-level logic must synchronize drag intent and data writes.

Primary source:
- https://github.com/riktar/jkanban

### 3) SortableJS Clone Pattern

- SortableJS supports explicit clone behavior in cross-list groups:
  `group.pull = 'clone'`, plus `revertClone`.
- This is a mature template for "source remains while target receives clone"
  interactions.
- Useful as a reference model even if we stay on jKanban/dragula.

Primary source:
- https://github.com/SortableJS/Sortable

### 4) dnd-kit Overlay + Stable IDs

- dnd-kit strongly recommends `DragOverlay` for cross-container movement and
  requires unique draggable ids per context.
- This reinforces two design rules we should keep:
  - single drag-intent pipeline
  - strict unique card identity model

Primary sources:
- https://docs.dndkit.com/api-documentation/draggable
- https://docs.dndkit.com/api-documentation/draggable/drag-overlay

### 5) Atlassian Pragmatic DnD (Performance-Oriented Architecture)

- Pragmatic DnD is modular, adapter-based, and optimized by importing only
  required pieces (drop targets, monitors, adapters).
- This is a strong long-term pattern for predictable high-performance drag
  operations.

Primary source:
- https://atlassian.design/components/pragmatic-drag-and-drop/core-package/

## Recommended Direction

- Keep jKanban + dragula short-term.
- Standardize all copy/move behavior around generator semantics.
- Avoid schema conflicts by not storing multi-date arrays in `scheduled` until
  PTT is updated.

### Domain Rules (Target)

- `move`: normal drag; source assignment removed, target assignment set.
- `generator-copy`: source remains; target assignment added/created.
- `template-generator`: source is static template; dropping creates/assigns item.

The important point is that drag intent is resolved once and used by both UI and
persistence.

## Phased Plan

### Phase 0: Stabilize Current Behavior

- Define a single drag intent object resolved at drag start.
- Ensure refresh requests are queued and replayed rather than dropped during
  drag/cooldown windows.
- Add trace logs keyed by drag id:
  - `intent:resolved`
  - `persist:start`
  - `persist:done`
  - `reconcile:applied`

Acceptance criteria:
- No manual refresh needed after drop.
- UI state and persisted state always match.

### Phase 1: Shift-Copy Engine

- Shift-copy of normal cards reuses the standard jKanban/dragula copy path;
  no per-card generator branching remains.

Acceptance criteria:
- Shift-copy behaves identically across presets.
- No special-case drift between copy sources.

### Phase 2: Data Contract Alignment with PTT

- Decide one of these before shipping "multi-day single-note" broadly:
  - Option A: Keep `scheduled` scalar, store extra assignments in a new field
    (for example `scheduledDates`) supported by planner only.
  - Option B: Upgrade `ptt-core` schema/parser/views to support list-valued
    scheduling.
- Update recipe database, planner views, and any sorting/filtering code to match
  the chosen contract.

Acceptance criteria:
- No parser/view breakage in PTT.
- Planner and database filters agree on scheduled state.

### Phase 3: Performance Hardening

- Serialize writes per file path to avoid race conditions under rapid drops.
- Add low-cost optimistic reconciliation with deterministic replay.
- Benchmark drop-to-visible latency and enforce guardrails in smoke tests.

Acceptance criteria:
- P95 drop-to-visible latency target met on real vault data.
- No flicker and no stale ghost states after rapid repeated drags.

## Decision Gates

- Gate 1: confirm canonical data shape for multi-day scheduling (`scheduled`
  scalar vs list-capable contract).
- Gate 2: confirm whether to remain on jKanban/dragula long-term or migrate to a
  modern DnD core after stabilization.

## Validation Checklist

- Shift-copy within weekly planner preserves source card.
- Target day updates immediately without manual refresh.
- Move vs copy behavior remains correct when dragging quickly.
- Recipe database scheduled filter/sort remains valid.

## Testing and Validation Strategy

### Automated Tests

- Unit tests (organiser):
  - scheduling field normalization and write-shape (`scheduled` +
    `scheduledDates`)
  - date-column resolution from mixed scheduling fields
  - drag intent resolution logic (`move` vs `generator-copy`)
- Deterministic web diagnostic:
  - `tests/diagnostics/shift-drag.spec.ts` via
    `playwright.diagnostics.config.ts`
  - relies on seeded `/home/vault` shim fixture data in web mode
  - emits before/after board snapshots plus debug log stream
- Regression tests:
  - multi-day single-note appears in each target day column
  - no duplicate file creation for shift-copy
  - reminder-to-marked delete rule still applies on move

### Manual Validation (Real Vault Data)

- Baseline flow:
  - drag move day A -> day B
  - verify immediate UI update
  - verify persisted frontmatter shape
- Shift-copy flow:
  - shift-drag day A -> day B
  - verify source remains in A and same note appears in B immediately
  - verify no manual refresh required
- Stress flow:
  - 10 rapid drags on same note across multiple columns
  - verify no stale ghost cards, no lost assignments

### Performance Budgets

- Drop-to-visible (UI) p95: <= 60ms on warm path.
- Drop-to-persisted-reconcile p95: <= 150ms local vault.
- No full-board rebuild in standard drop path.
- No full-vault rescan in interactive planner paths.

### Debug Signals

- Keep debug logs behind `window.__MEP_KANBAN_DEBUG__ = true`.
- Required events for triage:
  - `drag:copy:decision`
  - `drag:drop`
  - `drag:drop:commit`
  - `refresh:deferred`
  - `refresh:applied`
