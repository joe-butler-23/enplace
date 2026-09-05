# Changelog

All notable changes to Enplace will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Shared live cookbook: one merge document per household (Yjs), persisted on every device, synced through a y-websocket relay, addressed by an unguessable link in the URL fragment. Works on every browser and phone with no install or sign-in
- Cookbook panel in Settings: share link and QR code, connection status, zip export and import, starting a new cookbook, and pasting another cookbook's link
- `scripts/cookbook-relay.mjs`: the reference relay for tests and self-hosting
- Pixel-art Enplace bowl mark at the foot of the left rail, held back at 55% opacity, on the page ground with no plate behind it
- Full Enplace logo lockup at the top of the README
- Self-hosted Fraunces and Space Grotesk web fonts, so typography no longer depends on what the viewing device happens to have installed
- Cook log presentation on the recipe page: a collapsible section reading the `## Cook Log` entries the planner already writes, with their ratings and make-again verdicts
- Single `:root` design-token palette that every surface inherits
- MIT license file

### Changed

- The cookbook document is the only storage path; a folder on disk comes only from the zip export
- Shopping and plan edits apply a pure function to the live shared text inside one transaction, keyed by item rather than line, so no stale snapshot exists to merge
- Content-Security-Policy allows `wss:` connections for the relay
- The Recipe Database is the app's landing view and owns "/"; the Planner moves to "/planner", and "/database" stays a working alias that canonicalises to "/"
- Recipe Database sits above Planner in the left rail
- The left rail is icon-only with no expand control, so there is one sidebar width instead of two layouts to keep working
- Settings opens as a dialog over the current view and contains only browser-local recipe sort and filter preferences
- Recipe page masthead and columns now share one grid, so a recipe cover aligns with the method column and every recipe renders the same 16:9 cover
- Recipe metadata reduced to source and tags; the step count, added/scheduled dates and cooked state are no longer restated on the page
- Method steps are toggled by their own step number rather than a separate checkbox, and one Reset clears both columns
- Ingredient checkboxes reuse the shopping list's checkbox, including its focus ring and touch sizing
- Planner horizontal scrolling behaviour tuned to reduce x-axis jank

### Fixed

- The hosted relay hibernates idle sockets, so a tab left open no longer bills Durable Object time all day, and every update is durable before the message is acknowledged
- The hosted relay now enforces the reference relay's limits: message size, document size, awareness size and identity, connections per room, and new-room creation per address
- One unreadable shared record no longer locks every device out of a cookbook: records authenticate one by one, an unreadable one is quarantined and reported in a banner, and writes are refused while local edits cannot be sealed rather than silently accepted
- Browser Back returns from an open recipe to the database, and the in-app Back control pops one real history entry instead of rewriting the current one
- The split preview no longer remounts and drops typing when its file changes underneath it

- Shared shopping ticks no longer stall behind whole-cookbook uploads: the encrypted wire document is now the persisted copy, so opening syncs only the records a device lacks, small edits fold together instead of triggering a full snapshot every 64 records, and a snapshot is written only when the log holds more than twice the live cookbook
- An app added to the home screen launches the cookbook it was added from: the manifest is generated with the link in its start URL instead of the site root
- Returning to the app, or regaining the network, replaces the relay connection at once, so a half-open socket left by the lock screen no longer holds ticks for up to thirty seconds
- A saved setting no longer reverts in the field it was typed into, and the view behind the settings dialog now follows the change instead of rendering from a stale copy
- Nine CSS variables were referenced but never defined, silently invalidating those declarations: the planner count pill rendered dark text on its accent background, `.card-badge` had neither background nor text colour, and success/error ledger statuses were indistinguishable from normal text
- Secondary and label text now meet the WCAG AA 4.5:1 contrast minimum on every ground they sit on
- Completed ingredients and steps stay readable when ticked; the strikethrough carries the state instead of fading the text out of contrast

### Removed

- The one-time upgrade path for links from before encryption: those links, rooms, and saved plaintext copies are no longer read
- Demo mode and the in-memory sample adapter; a fresh cookbook seeded with the sample pack replaces them
- The desktop File System Access folder mode, its gate screen, and the storage-mode and relay-override settings
- The three-way snapshot merge; direct edits made it unnecessary
- The Obsidian plugin-API emulation, the Tauri command layer, the plan-store frontmatter projection, and PTT-era query types; views and the planner now read `src/core.ts` and the storage adapter directly
- The settings file, personal vault-path default, recipe/images folder settings, and automatic folder creation
- Standalone kanban build targets and obsolete native-runtime configuration
- Recipe database card-width and max-card settings, which were configuration nobody needed to change; both consumers already had the same values as constants
- The sidebar expand toggle, brand block and vault-path footer, and the "connected to a host-managed vault" / "Managed by host server" copy
- 246 lines of CSS whose classes were referenced nowhere in the app, tests, scripts or markup
- The duplicate `--shopping-*` and Obsidian-compatibility palettes, and the decorative monospace labels

## [0.1.0] - 2026-01-08

### Added

- Initial release
- Agent-led recipe extraction from URL, text, and image sources
- Weekly Organiser for meal planning
- Recipe Database view with search and filters
- Built-in shopping list integration
