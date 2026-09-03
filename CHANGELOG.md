# Changelog

All notable changes to Enplace will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Shared live kitchen: one merge document per household (Yjs), persisted on every device, synced through a y-websocket relay, addressed by an unguessable link in the URL fragment. Works on every browser and phone with no install or sign-in
- Kitchen panel in Settings: share link and QR code, connection status, relay override, zip export, file, folder, and zip import, switching and forgetting kitchens, and the desktop folder opt-in
- `mep mirror`: keeps a folder on disk and a kitchen in step in both directions through the relay, preserving differing local files as `.local-<stamp>` siblings
- `scripts/kitchen-relay.mjs`: the reference relay for tests and self-hosting

- Pixel-art Enplace bowl mark at the foot of the left rail, held back at 55% opacity, on the page ground with no plate behind it
- Full Enplace logo lockup at the top of the README
- Self-hosted Fraunces and Space Grotesk web fonts, so typography no longer depends on what the viewing device happens to have installed
- Cook log presentation on the recipe page: a collapsible section reading the `## Cook Log` entries the planner already writes, with their ratings and make-again verdicts
- Single `:root` design-token palette that every surface inherits
- External markdown change parity path from the vault watcher to in-app vault/metadata updates
- Kanban drag mirror/ghost styling controls for clearer drag affordance
- Planner image-source reuse for cached blob URLs to reduce post-drop image flicker
- MIT license file
- Image dimension limit (800px max in any direction)
- Image size limit (10MB maximum)
- Infinite loop protection in archive path generation
- Improved error logging with structured context
- Recipe Database virtualization for faster rendering
- Enhanced image lazy loading with intersection observer

### Changed

- The kitchen document is the only storage path. A folder on disk comes from `mep mirror` or the zip export
- Shopping and plan edits apply a pure function to the live shared text inside one transaction, keyed by item rather than line, so no stale snapshot exists to merge
- Content-Security-Policy allows `wss:` connections for the relay

### Removed

- Demo mode and the in-memory sample adapter; a fresh kitchen seeded with the sample pack replaces them
- The desktop File System Access folder mode, its gate screen, and the storage-mode and relay-override settings
- The three-way snapshot merge; direct edits made it unnecessary

- The Recipe Database is the app's landing view and owns "/"; the Planner moves to "/planner", and "/database" stays a working alias that canonicalises to "/"
- Recipe Database sits above Planner in the left rail
- The left rail is icon-only with no expand control, so there is one sidebar width instead of two layouts to keep working
- Settings opens as a dialog over the current view and contains only browser-local recipe sort, filter, and marked-column width preferences

- Recipe page masthead and columns now share one grid, so a recipe cover aligns with the method column and every recipe renders the same 16:9 cover
- Recipe metadata reduced to source and tags; the step count, added/scheduled dates and cooked state are no longer restated on the page
- Method steps are toggled by their own step number rather than a separate checkbox, and one Reset clears both columns
- Ingredient checkboxes reuse the shopping list's checkbox, including its focus ring and touch sizing
- Consolidation plan updated with completion status and remaining scope
- Database data loading is warmed in background instead of front-loading all work at startup
- Database query results now use optimistic in-memory cache to avoid blank state on refresh/re-entry
- Vault revision bumps are more aggressively coalesced to reduce UI churn during file-event bursts
- Optimistic frontmatter persistence now writes normalized full documents directly in-app for DnD schedule moves
- Vault path lookup moved to indexed maps for O(1) file resolution
- External watcher handling now applies targeted file updates before fallback full refresh
- Optimistic frontmatter writes now update local cache/content immediately
- Active note pane now auto-syncs on file/metadata changes with flicker-free content updates
- Frontmatter write composition is now idempotent and keeps a stable frontmatter/body separator
- Planner horizontal scrolling behavior tuned to reduce x-axis jank
- Error messages sanitized to prevent sensitive data exposure
- File processing includes race condition protection
- Regex patterns compiled as constants for better performance

### Removed

- The Obsidian plugin-API emulation (`src/platform.ts`), the Tauri command layer (`browser-invoke.ts`, `commands.ts`), the plan-store frontmatter projection, PTT-era query types, and the `moment` dependency; views and the planner now read `src/core.ts` and the folder adapter directly
- The settings file, personal vault-path default, recipe/images folder settings, and automatic folder creation
- Standalone kanban build targets and obsolete native-runtime configuration
- Recipe database card-width and max-card settings, which were configuration nobody needed to change; both consumers already had the same values as constants
- The sidebar expand toggle, brand block and vault-path footer, and the "connected to a host-managed vault" / "Managed by host server" copy
- 246 lines of CSS whose classes were referenced nowhere in the app, tests, scripts or markup
- The duplicate `--shopping-*` and Obsidian-compatibility palettes, and the decorative monospace labels

### Fixed

- A saved setting no longer reverts in the field it was typed into, and the view behind the settings dialog now follows the change instead of rendering from a stale copy
- Nine CSS variables were referenced but never defined, silently invalidating those declarations: the planner count pill rendered dark text on its accent background, `.card-badge` had neither background nor text colour, and success/error ledger statuses were indistinguishable from normal text
- Secondary and label text now meet the WCAG AA 4.5:1 contrast minimum on every ground they sit on
- Completed ingredients and steps stay readable when ticked; the strikethrough carries the state instead of fading the text out of contrast
- The empty `## Cook Log` heading that `mep recipe import` writes no longer appears as a stray heading in the recipe notes region
- Planner card image refresh behavior after drag/drop (cached blob reuse path)
- Additional planner drop flicker reduction by preserving DOM nodes during reorder reconciliation
- Repeated reschedule frontmatter writes no longer accumulate extra blank lines before recipe body
- Removed remaining blank-line regression source for drag/drop schedule updates by bypassing Rust partial-frontmatter rewrite in optimistic path
- Redundant metadata changed events when frontmatter/tags are unchanged
- Potential infinite loop in archive path generation
- Race condition in file processing

## [0.1.0] - 2026-01-08

### Added

- Initial release
- Agent-led recipe extraction from URL, text, and image sources
- Weekly Organiser for meal planning
- Recipe Database view with search and filters
- Built-in shopping list integration
