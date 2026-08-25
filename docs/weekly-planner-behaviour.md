# Weekly Planner Behaviour

Status: Active  
Last updated: 2026-08-25

This document defines current expected planner behaviour for weekly mode to avoid
regressions in drag/drop and note creation flows.

## Marked Column

The marked column shows normal marked notes using standard card behaviour. Any
legacy `_mep/office-days` content still present in a vault is ignored: it is
never listed on the board and never modified.

## Quick Meal Creation (Meal Planner Mode)

- Pressing column `+` opens one modal form (not browser prompt).
- Modal fields:
  - `Title` (required)
  - `Ingredients` (optional, comma/newline separated)
  - `Notes` (optional free text)
- Saving creates a reminder note with:
  - `type: reminder`
  - `scheduled: <column date>`
  - `quickMeal: true`
  - generic quick-meal cover image
  - markdown sections for ingredients/method/notes
  - file stored under `eventsFolder` (default `events/`)

### Reminder Completion Rule

- In planner drag/drop, moving a reminder to the `Marked` column means
  "complete now", so the reminder note is deleted (not archived).
- This applies to quick-meal reminders and any other reminder cards.

### Drag Duplication Rule

- Holding `Shift` while dragging a normal card performs a generator-style copy
  for that drag:
  - source card remains in place
  - no new note file is created
  - the same note gains an additional scheduled date for the drop day
- The note keeps a single identity and stores day assignments as:
  - `scheduled`: primary scalar date string
  - `scheduledDates`: date array when assigned to multiple days
- Moving (non-Shift drag) day-to-day removes only the source day assignment
  and applies the target day assignment on the same note.
- `Shift`+drop to `Marked` is ignored to avoid destructive or ambiguous
  duplicate semantics.

## Card Layout Expectations

- Recipe cards in day columns use reduced cover height when 2+ recipe cards are
  adjacent in the same day lane.
- Day columns should stretch to fill available vertical app space (minimizing
  bottom dead space at common desktop heights).
- Weekly planner uses 5 equal grid tracks (marked + 4 day lanes per row), and
  all tracks share the same minimum width variable (`--col-min-width`).
- When there is extra horizontal space, all tracks expand equally via `1fr`.
- When the viewport is narrower than the minimum matrix width, the kanban area
  scrolls horizontally and all tracks stay at the configured minimum.
- Resizing from the marked-column divider updates that shared minimum width, so
  marked and day columns resize together.
- Weekly planner root keeps an explicit right-side gutter (40px) so the final
  column does not visually touch the viewport edge.
- In day columns, when more than one recipe card is present, recipe cover images
  switch to a compact half-height ratio (`2:1`) to fit more cards onscreen.

## Lessons Learned (Layout)

- Do not apply planner grid styles to the jKanban host element. jKanban creates
  its own inner `.kanban-container`, so styling both host and inner container
  causes nested-grid conflicts and incorrect board sizing.
- Use explicit weekly grid placement (`gridRow`/`gridColumn`) for each column
  to keep the 2-row layout deterministic:
  marked spans rows 1-2, Mon-Thu row 1, Fri-Sun row 2.
- Avoid JS pixel-height forcing per board. Let CSS Grid own row sizing and only
  compute the outer kanban viewport height once from available shell space.
- Keep a single source of truth for column width (`--col-min-width`) to avoid
  marked/day divergence bugs.
- Use horizontal scroll when viewport width is smaller than the weekly matrix
  minimum width.

## Lessons Learned (Drag Performance)

- Planner drops must not depend on expensive global vault rescans.
- Persistence paths update vault indexes/metadata incrementally so dropped
  reminders appear near-instantly in target day columns.
- Avoid immediate full-board rebuilds after drop; refresh affected columns only.
- For delete-on-marked flows, remove the dragged reminder card optimistically on
  drop and reconcile with persistence result to avoid linger/flicker.

## Lessons Learned (Multi-Date Scheduling)

- Board item IDs must be per-entry (`filePath::columnId`), not per-file, when a
  single note can appear in multiple columns.
- Metadata update paths must update/remove all entry IDs for a file atomically;
  one-entry-per-file maps cause stale DOM and "refresh required" bugs after DnD.
- For date-based boards, stamp each board entry with the owning column date so
  each rendered card has deterministic schedule context.

## Lessons Learned (Ctrl/Cmd Click Preview)

- Split-open intent must not be derived only from the `click` event modifier
  flags. In jKanban/dragula flows this can be stale or missing after drag/click
  transitions.
- Use a deterministic resolver from multiple sources:
  - direct click modifier state
  - live keyboard modifier state (`Control`/`Meta`)
  - fresh `mousedown` click intent for the same card
- Preview pane content must be loaded with request-id guarding so older async
  reads cannot overwrite the currently selected card.
- On card switch, clear prior preview content immediately and show a loading
  state until the new file read completes; do not render stale editor content.
- For frontmatter-only notes, render a fallback heading in preview mode instead
  of showing an empty pane.
- MDXEditor (and similar rich text editors) captures the `markdown` prop only on
  mount; subsequent prop changes are ignored. When the editor is rendered inside
  a component with async-derived state (e.g., `renderedMarkdownWithResolvedImages`
  starting as `""`), the first render passes empty content and the editor never
  updates. Fix by computing the initial state eagerly from `content` prop using
  a lazy initializer: `useState(() => parseFrontmatter(content).body)`.

## Testing Notes

- Added unit coverage for split-open resolver edge cases in:
  - `src/modules/organiser/tests/click-intent.test.ts`
- Existing Playwright smoke coverage for ctrl-click can skip when the active
  vault does not expose at least two suitable cards for the selected presets.
- For regression checks, run manual verification against real vault data:
  - ctrl-click card A
  - ctrl-click card A again
  - ctrl-click card B
  - verify pane always matches the latest clicked card
- Deterministic DnD diagnostics:
  - `npx playwright test --config playwright.diagnostics.config.ts`
  - includes shift-copy coverage.
