# Changelog

All notable changes to Mise en Place will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- UI consistency specification document (`docs/ui-consistency-spec.md`)
- Native vault watcher commands in Tauri backend (`mep_watch_vault`, `mep_unwatch_vault`) using `notify`
- External markdown change parity path from native watcher to in-app vault/metadata updates
- Kanban drag mirror/ghost styling controls for clearer drag affordance
- Planner image-source reuse for cached blob URLs to reduce post-drop image flicker
- Idle planner image warmup for above-the-fold recipe cards
- MIT license file
- Image dimension limit (800px max in any direction)
- Image size limit (10MB maximum)
- Infinite loop protection in archive path generation
- Improved error logging with structured context
- Recipe Database virtualization for faster rendering
- Enhanced image lazy loading with intersection observer
- Privacy documentation for CORS proxy usage
- **Tauri standalone:** In-memory vault caching with `AppState`
- **Tauri standalone:** Streamed data loading via `mep_recipe_database_stream` (Channel API)
- **Tauri standalone:** Rust-based search with `nucleo-matcher`
- **Tauri standalone:** Thumbnail generation with SHA256 disk caching
- **Tauri standalone:** Cache invalidation on file changes

### Changed

- Root docs rewritten for standalone Tauri workflow; product-first root README restored alongside CONTRIBUTING.md
- Consolidation plan updated with completion status and remaining scope
- App initialization now supports deferred initial vault refresh for faster first paint
- Planner/Database/Health lazy views are preloaded during idle time to reduce first-switch lag
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
- Ledger persistence now handles failures with retry logic
- File processing includes race condition protection
- Regex patterns compiled as constants for better performance
- **Tauri standalone:** All Rust commands wrapped in `spawn_blocking`
- **Tauri standalone:** File watcher debounce increased to 500ms
- **Tauri standalone:** MutationObserver paused during drag operations

### Fixed

- Planner card image refresh behavior after drag/drop (cached blob reuse path)
- Additional planner drop flicker reduction by preserving DOM nodes during reorder reconciliation
- Repeated reschedule frontmatter writes no longer accumulate extra blank lines before recipe body
- Removed remaining blank-line regression source for drag/drop schedule updates by bypassing Rust partial-frontmatter rewrite in optimistic path
- Redundant metadata changed events when frontmatter/tags are unchanged
- Unhandled promise rejections in ledger flush
- Potential infinite loop in archive path generation
- Race condition in file processing

## [0.1.0] - 2026-01-08

### Added

- Initial release
- Agent-led recipe extraction from URL, text, and image sources
- Weekly Organiser for meal planning
- Recipe Database view with search and filters
- Built-in shopping list integration
- Health view for monitoring recent activity
