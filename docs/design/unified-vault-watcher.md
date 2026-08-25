# Unified Rust Vault Watcher

Status: implemented.

## Timer doctrine

MEP uses producer completion and owned state as its primary evidence. A timer standing in for knowledge that exists somewhere is a design smell. When MEP owns both sides of a boundary, it emits completion, generation, connection, or liveness state instead of inferring state or failure from silence, cooldowns, expiry windows, or guessed heartbeats.

Bounded reconciliation timing is permitted only where a producer or platform has a demonstrated delivery gap and no completion signal. The retained native 750 ms watcher deadline covers platforms or producers that fail to deliver `CLOSE_WRITE`; it begins with the first unmatched create or modify and later noise cannot extend it. Correctness tests advance an injected `Instant` and never sleep.

## Implemented architecture

### Phase 1: completion-driven native coalescing

The `mep-core` `WatchService` owns the direct `notify = "6.1"` watcher and file-write coalescing. Linux `Access(Close(Write))` completes pending file create and modify lifecycles immediately. Directory creation, rename, and removal are already complete lifecycle events and emit directly. Stop and channel disconnection wake the loop through owned messages, preserving cancellation without a shutdown poll.

### Phase 2: self-sufficient settled batches

Each native event entry carries path, event kind, modification time, size, FNV-1a-64 content hash, optional inline content up to 32 KiB, and a `selfAuthored` marker. JS applies this payload without the former `stat` plus `readTextFile` cascade. Native writes register their expected hash before persistence; the first readable watcher event consumes that intent and suppresses only an exact match.

### Phase 3: one monotonic generation and attention-driven reconciliation

Rust owns one process-lifetime monotonic `u64` generation. Every non-empty settled batch advances it exactly once. JS advances its cursor after the batch applies or source-truth reconciliation succeeds.

```rust
pub struct VaultWatchBatch {
    pub generation: u64,
    pub alive: bool,
    pub events: Vec<VaultWatchEvent>,
}

pub struct VaultWatchStatus {
    pub generation: u64,
    pub alive: bool,
    pub changed: bool,
}
```

`mep_watch_vault` returns the generation observed before the new watcher begins, so an event emitted during startup cannot be hidden by adopting a newer baseline. `mep_vault_changes_since(generation)` reads the current generation and whether the owned watcher thread is still running; it performs no filesystem scan.

The watcher transport emits `alive: false` when `notify` reports failure or the watcher message channel disconnects. A thread that exits without sending that message is still visible through `JoinHandle::is_finished()` on the next attention check.

## Frontend settlement

`App.tsx` serializes watcher batches through one promise chain. A contiguous batch applies each relevant entry, coalesces its vault events into one `vaultRevision` increment, and advances the cursor. Self-authored and irrelevant entries still advance the cursor after the batch settles.

An entry that cannot apply in place triggers one immediate full-vault refresh after the batch. A non-contiguous generation proves missed delivery and triggers one immediate refresh without replaying the partial batch. Reconciliation forces markdown reads even when modification time and size are unchanged, preserving cache correctness on coarse-timestamp filesystems. A failed refresh leaves the cursor behind so the next batch or attention check retries from source truth.

Window focus and visible `visibilitychange` events call `mep_vault_changes_since` in both Tauri and web-host mode. Equal live state does nothing. A newer generation refreshes the vault once before advancing the cursor. Explicit dead state refreshes and replaces the watcher only after that refresh succeeds. A failed refresh leaves the dead watcher in place, so the next attention event observes the same owned failure state and retries.

This settlement deletes the 650/1200 ms JS coalescer, the 180/120 ms scheduled-refresh fallback, and the unconditional 60-second/5-minute full-vault polling interval. No heartbeat, silence window, cooldown, time-to-live value, replay log, or periodic reconciliation loop replaces them.

## Reconciliation evidence

| Observed state | Action | Evidence |
|---|---|---|
| Contiguous live batch | Apply the batch and advance the cursor | Native generation is exactly `cursor + 1` |
| Batch entry cannot apply | Refresh vault once, then advance on success | The targeted mutation reported failure |
| Incoming generation skips a value | Refresh once, then advance on success | Native generation proves a delivery gap |
| Attention status has a newer generation | Refresh once, then advance on success | Native state proves unseen work |
| Channel or thread state reports dead | Refresh; replace only after success | Owned dead state remains the retry signal after refresh failure |
| Web-host SSE reconnects behind the current generation | Refresh vault once | Authenticated resume state proves delivery was missed |

## Ownership boundaries

- Phase 1 retains ownership of completion coalescing, the first-event 750 ms reconciliation deadline, and cancellation.
- Phase 2 retains ownership of payload enrichment, inline-content limits, scan-cache invalidation, and single-use self-write provenance.
- Phase 3 owns native generation, watcher liveness exposure, JS cursor settlement, and attention reconciliation.
- Phase 4 owns extraction to `mep-core`, the vault subscription, and web-host server-sent events.
- Kanban timing, human-input debounce, cache persistence coalescing, user-interface animation timing, and retry/rate-limit boundaries remain outside this watcher design.

## Phase 4 transport

The shared watcher accepts named path subscriptions. The active application
installs one vault subscription covering the configured root. Initial startup
preserves the supplied cursor and establishes that subscription. Vault-root
replacement also preserves the cursor and establishes the replacement first,
then performs one full source-truth reconciliation because an edit during the
stop/start gap cannot advance generation. Dead-watcher recovery retains its
reconcile-before-restart order and does not force a second full refresh after
restart unless the returned status proves newer work.

Web-host mode reuses the persistent authenticated Rust helper to run the same `mep-core` watcher. The existing HTTP server exposes a bearer-authenticated SSE stream, reports explicit connection state, accepts `Last-Event-ID` resume cursors, and autonomously restarts an owned failed helper only after the frontend has reconciled source truth. The Node hub translates each helper-process generation epoch into one host-lifetime monotonic generation, so a helper restart cannot regress below a client cursor. It keeps no replay log or slow-client queue: a stale resume cursor produces `changed: true`, and a backpressured SSE response is destroyed immediately so reconnect reconciliation owns recovery. The server binds and runs locally without a dependency on any specific host machine; tailnet exposure remains an optional deployment choice behind the existing host and bearer checks.

Phase 4 remains scoped to the vault path. It adds no generic publish-subscribe layer, WebSocket transport, dependency family, heartbeat, periodic refresh loop, or kanban timing change.

## Focused proof

- Rust generation tests prove monotonic advancement, changed-since comparison, and explicit dead state without sleeping.
- Existing Rust completion-coalescer tests preserve close-write settlement, first-event fallback, lifecycle delivery, and cancellation with injected `Instant` values.
- App cursor-state tests prove contiguous versus missing generations, monotonic cursor advancement, attention reconciliation, and explicit recovery selection.
- Platform vault tests preserve self-sufficient metadata/content application, large-file targeted reads, boundary rejection, and cache correctness.
- Helper and server tests prove authenticated SSE, generation resume, explicit failure, path mapping, and owned restart without browser execution.
- The timer audit must contain no watcher silence timer or full-vault polling source.
