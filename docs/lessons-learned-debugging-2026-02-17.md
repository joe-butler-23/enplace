# Lessons Learned - Debugging Session (2026-02-17)

Scope:
- Windows startup failures (`forbidden path` during settings/vault operations).
- Follow-up diagnosis only (no fixes) for:
  - Recipe images missing in Recipe Database cards.
  - Marked cards not appearing in Marked column.

## What Actually Helped

1. Keep diagnostics timestamps and startup phases in the app UI.
- The startup event stream made it clear where failures occurred (settings read vs vault mkdir vs UI path).
- This avoided guessing between Tauri runtime detection, frontend logic, and FS capabilities.

2. Separate capability/scope failures from app logic regressions.
- Startup `forbidden path` errors traced to Tauri v2 capability scope configuration and path-access shape.
- UI behavior bugs later were unrelated to startup ACL fixes and required separate triage paths.

3. Validate against current shipped code paths, not assumptions.
- We verified exact active code paths in `App.tsx`, `pttNode.ts`, and organiser board rendering.
- This prevented conflating old Windows incidents with current Linux-local organizer regressions.

4. Keep v2-only mental model/documentation.
- Tauri v2 capability semantics are different enough that v1 guidance causes confusion.
- Using v2-only checklists/runbook language reduced false leads.

## What Caused Delays/Confusion

1. Multiple concurrent symptoms looked related but were from different layers.
- Startup `forbidden path` and Kanban behavior looked connected chronologically, but were distinct defects.

2. Inconsistent image path shapes across features.
- Recipe creation and recipe listing paths are normalized differently in different code paths.
- This makes one UI (Recipe View) work while another (Recipe Database cards) fails.

3. Organiser card rendering divergence.
- There are two card render approaches in codebase (React component vs string HTML in jKanban path).
- Marked-toggle behavior exists in one path and is absent in the other.

## Diagnosis: Recipe Images Missing In Recipe Database

Current likely root cause:
- `buildRecipeDatabaseView` reads only `frontmatter.cover` directly (`src/pttNode.ts:132`) and does not use the shared cover normalization utility.
- `resolveDatabaseCover` in app layer does not handle all relative cover variants, especially `images/...` paths when `settings.imagesFolder` is custom (`src/App.tsx:1457`).
- Recipe writer can intentionally store relative paths like `images/<file>.webp` (`src/modules/cooking/services/RecipeWriter.ts:125`).

Why this matches observed behavior:
- Recipe markdown view can still resolve embedded image links.
- Database card path goes through separate `coverPath -> absolutePath -> thumbnail` pipeline and can fail to resolve the same image.

Evidence:
- `src/pttNode.ts:132`
- `src/App.tsx:1457`
- `src/modules/cooking/services/RecipeWriter.ts:125`
- `src/modules/cooking/utils/metadata.ts:51` (existing robust normalizer not used in `pttNode` path)

Confidence:
- High.

## Diagnosis: Marking Card Does Not Move To Marked Column

Current likely root cause:
- Kanban cards in organiser path are rendered via string HTML in `useKanbanBoard` (`renderItemHTML`) rather than the React `OrganiserCard` component.
- `renderItemHTML` includes icon/title/cover/remove button but no marked checkbox or marked-toggle event wiring (`src/modules/organiser/hooks/useKanbanBoard.ts:451`).
- The checkbox/onToggleMarked exists in `OrganiserCard` (`src/modules/organiser/components/OrganiserCard.tsx:177`) but that path is not used for current jKanban item rendering.

Why this matches observed behavior:
- UI can show cards and allow drag/drop while mark toggling no longer updates planner behavior from card interaction.
- Marked-column routing logic itself still appears present (`src/modules/organiser/utils/field-manager-fixed.ts:202`), so failure is likely at interaction/render layer, not column mapping.

Evidence:
- `src/modules/organiser/hooks/useKanbanBoard.ts:451`
- `src/modules/organiser/components/OrganiserCard.tsx:177`
- `src/modules/organiser/utils/field-manager-fixed.ts:202`

Confidence:
- High.

## Verification Checklist (No Code Changes)

1. Recipe DB image issue:
- Inspect sample recipe frontmatter `cover` value (`images/...`, filename-only, or absolute vault path).
- In running app/devtools, log `resolveDatabaseCover(coverPath, sourcePath)` output for one failing recipe.
- Confirm whether thumbnail command receives a valid absolute path.

2. Marked behavior issue:
- Inspect rendered DOM inside Kanban card; confirm checkbox markup (`.organiser-card__marked-input`) is absent.
- Confirm no event handler path in `useKanbanBoard` for marked toggle actions.

## Preventive Guardrails

1. Single canonical cover resolver for all recipe surfaces.
- Recipe DB, planner cards, and recipe detail should all resolve cover path through one utility.

2. One card rendering path per board surface.
- If jKanban must render HTML strings, interaction controls (marked toggle) must be explicitly preserved with delegated handlers.

3. Keep release smoke checks aligned to active UX paths.
- Add explicit checks for database cover images and marked-column toggle behavior in addition to startup checks.
