# Lessons Learned

## Modular, Composable Architecture

- Isolate complex behaviors (like drag-and-drop) into dedicated hooks and components.
- Use class name prefixes so feature styling does not leak into other UI areas.
- Scope DOM queries to a feature container ref to prevent cross-feature side effects.
- Prefer render functions for item UIs so DnD can be reused across screens.
- Keep data access in a dedicated utility so UI changes do not impact storage logic.
- When a library exports a constructor in a non-standard way, add a resolver instead of assuming a default export.
- Prefer event delegation for card clicks when the DnD library does not pass through MouseEvent data.
- When integrating third-party UI (like Pikaday), keep styling overrides scoped to the component to avoid clashing with Obsidian theme button styles.
- Use presets to keep domain-specific logic (fields, filters) declarative and swappable.
- Treat runtime filter/group/sort as optional layers (work in progress) to avoid hard-coding UI assumptions.

## Frontmatter + DnD Mapping

- Treat `scheduled` as the source-of-truth date field and `marked` as the backlog flag; keep the mapping explicit.
- Normalize legacy fields (like `date`) in one place to avoid drift between UI and storage.
- Verify column IDs match normalized frontmatter values when items do not appear where expected.
- Add targeted debug logs around transfers and frontmatter writes, then remove once stable.
- Use frontmatter `type` to include items in presets instead of relying on folder paths.
- For multi-day scheduling, keep one note and use a PTT-safe shape:
  scalar `scheduled` + optional `scheduledDates` array for additional days.
- Use per-entry card IDs (`filePath::columnId`) so one note can render in multiple day columns without stale DOM state.
- For Shift-drag copy behavior, update `scheduled` on the same note instead of creating duplicate files.
- Keep one drag source of truth (`dragIntent`) captured at drag start and reused through drop + commit.
- jKanban wraps dragula and does not expose `drake.options` for runtime copy mutation in our bundle path; wire copy semantics at dragula init time instead.
- Avoid parallel drag systems (jKanban dragula + separate HTML5 `dataTransfer`) for planner cards. Generator cards should use the same dragula copy lifecycle as normal cards.
- Office generator template cards and persisted office reminder cards must share the same class and inner markup contract to prevent style shifts after drop/refresh reconciliation.
- Deleting reminders via drop-to-marked should remove the card optimistically in the drop path, then reconcile with persistence to avoid transient "stuck" cards.

## Sorting + Null Handling

- When sorting by optional date fields (e.g. `added`, `scheduled`), null/missing values must be handled explicitly in the comparator. Substituting a sentinel like `0` or `i64::MIN` causes nulls to silently sort to the wrong end depending on direction.
- Always push null values to the end regardless of ascending/descending direction, then reverse only the non-null comparison for descending.
- When there is both a JS fallback and a native Rust backend, the same sort logic must be correct in both. Fixing one does not fix the other.
- In Tauri apps, the Rust backend handles data operations in production (`isTauriRuntime()`), while the JS fallback is only used in browser dev mode. Debug logging at the JS layer will be invisible if the native path is active — add logging at the API boundary (`invoke` call site) to confirm which path is executing and what data it returns.

## CSS Grid Column Width

- CSS Grid calculates `fr` units once during initial layout. If the container starts constrained and later expands, Grid does **not** recalculate — columns stay at their minimum.
- `minmax(180px, 1fr)` treats 180px as a hard floor; use `minmax(0, 1fr)` if you want fr units to have full control.
- Media queries that override sidebar/shell widths can silently constrain the main pane. Trace from `window → shell → main → kanban` to find the real bottleneck.
- When all columns should share one width model, use a single `repeat(N, minmax(var(--col-min-width), 1fr))` instead of special-casing one column. This avoids resize handle drift and unequal distribution.
- Resize handles must be anchored to the rendered track width (not the CSS minimum), since `1fr` expansion makes the effective width larger than the minimum.

## Web Shim + Diagnostics

- For browser-only testing, seed deterministic fixture notes in shim FS so drag
  diagnostics are reproducible and do not depend on personal vault state.
- Keep shim `readDir` entry shape aligned with Tauri (`isDirectory` / `isFile`);
  missing flags can silently break vault traversal and make boards appear empty.
