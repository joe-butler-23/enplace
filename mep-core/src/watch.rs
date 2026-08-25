use notify::event::{AccessKind, AccessMode, CreateKind, ModifyKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, UNIX_EPOCH};

const INLINE_CONTENT_BYTES: u64 = 32 * 1024;
const FNV_OFFSET_BASIS_64: u64 = 0xcbf29ce484222325;
const FNV_PRIME_64: u64 = 0x100000001b3;
const RECONCILIATION_FALLBACK: Duration = Duration::from_millis(750);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchSubscription {
    pub id: String,
    pub path: PathBuf,
    #[serde(default)]
    pub excluded_paths: Vec<PathBuf>,
}

impl WatchSubscription {
    pub fn new(id: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        Self {
            id: id.into(),
            path: path.into(),
            excluded_paths: Vec::new(),
        }
    }

    pub fn excluding(mut self, path: impl Into<PathBuf>) -> Self {
        self.excluded_paths.push(path.into());
        self
    }

    fn includes(&self, path: &Path) -> bool {
        path.starts_with(&self.path)
            && !self
                .excluded_paths
                .iter()
                .any(|excluded| path.starts_with(excluded))
    }
}

fn resolve_path_for_containment(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return std::fs::canonicalize(path)
            .map_err(|error| format!("failed to resolve watch path {}: {error}", path.display()));
    }

    let mut current = path.to_path_buf();
    let mut suffix: Vec<OsString> = Vec::new();
    while !current.exists() {
        let component = current
            .file_name()
            .ok_or_else(|| format!("invalid watch path: {}", path.display()))?;
        suffix.push(component.to_os_string());
        current = current
            .parent()
            .ok_or_else(|| format!("invalid watch path: {}", path.display()))?
            .to_path_buf();
    }

    let mut resolved = std::fs::canonicalize(&current)
        .map_err(|error| format!("failed to resolve watch path {}: {error}", path.display()))?;
    for component in suffix.iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn validate_watch_scope(
    root: PathBuf,
    mut subscriptions: Vec<WatchSubscription>,
) -> Result<(PathBuf, Vec<WatchSubscription>), String> {
    let root = resolve_path_for_containment(&root)?;
    for subscription in &mut subscriptions {
        subscription.path = resolve_path_for_containment(&subscription.path)?;
        if !subscription.path.starts_with(&root) {
            return Err(format!(
                "watch subscription {} is outside the vault",
                subscription.id
            ));
        }
        for excluded in &mut subscription.excluded_paths {
            *excluded = resolve_path_for_containment(excluded)?;
            if !excluded.starts_with(&subscription.path) {
                return Err(format!(
                    "watch exclusion for {} must stay inside its subscription",
                    subscription.id
                ));
            }
        }
    }
    Ok((root, subscriptions))
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvent {
    pub kind: String,
    pub path: String,
    pub old_path: Option<String>,
    pub mtime_ms: Option<u64>,
    pub size: Option<u64>,
    pub content_hash: Option<String>,
    pub content: Option<String>,
    pub self_authored: bool,
    pub subscriptions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchBatch {
    pub generation: u64,
    pub alive: bool,
    pub events: Vec<WatchEvent>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    pub generation: u64,
    pub alive: bool,
    pub changed: bool,
}

#[derive(Default)]
struct WatchGeneration(AtomicU64);

impl WatchGeneration {
    fn current(&self) -> u64 {
        self.0.load(Ordering::Acquire)
    }

    fn next(&self) -> u64 {
        self.0.fetch_add(1, Ordering::AcqRel) + 1
    }

    fn status_since(&self, generation: u64, alive: bool) -> WatchStatus {
        let current = self.current();
        WatchStatus {
            generation: current,
            alive,
            changed: current > generation,
        }
    }
}

struct WatchController {
    stop_tx: Sender<WatcherMessage>,
    join_handle: JoinHandle<()>,
}

impl WatchController {
    fn stop(self) {
        let _ = self.stop_tx.send(WatcherMessage::Stop);
        let _ = self.join_handle.join();
    }
}

enum WatcherMessage {
    Event(notify::Result<Event>),
    Stop,
}

struct PendingChange {
    event: Event,
    reconcile_at: Instant,
}

#[derive(Default)]
struct EventCoalescer {
    pending_changes: HashMap<PathBuf, PendingChange>,
}

impl EventCoalescer {
    fn defer(&mut self, event: Event, now: Instant) {
        for path in &event.paths {
            let single_path_event = Event {
                kind: event.kind,
                paths: vec![path.clone()],
                attrs: event.attrs.clone(),
            };
            self.pending_changes
                .entry(path.clone())
                .and_modify(|pending| {
                    if !matches!(pending.event.kind, EventKind::Create(_)) {
                        pending.event = single_path_event.clone();
                    }
                })
                .or_insert(PendingChange {
                    event: single_path_event,
                    reconcile_at: now + RECONCILIATION_FALLBACK,
                });
        }
    }

    fn push(&mut self, event: Event, now: Instant) -> Vec<Event> {
        match &event.kind {
            EventKind::Create(CreateKind::Folder) => vec![event],
            EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_)) => {
                for path in &event.paths {
                    self.pending_changes.remove(path);
                }
                vec![event]
            }
            EventKind::Create(_) | EventKind::Modify(_) => {
                self.defer(event, now);
                Vec::new()
            }
            EventKind::Access(AccessKind::Close(AccessMode::Write)) => event
                .paths
                .iter()
                .map(|path| {
                    self.pending_changes
                        .remove(path)
                        .map(|pending| pending.event)
                        .unwrap_or_else(|| Event {
                            kind: event.kind,
                            paths: vec![path.clone()],
                            attrs: event.attrs.clone(),
                        })
                })
                .collect(),
            _ => Vec::new(),
        }
    }

    fn flush_expired(&mut self, now: Instant) -> Vec<Event> {
        let expired_paths = self
            .pending_changes
            .iter()
            .filter_map(|(path, pending)| (pending.reconcile_at <= now).then_some(path.clone()))
            .collect::<Vec<_>>();
        expired_paths
            .into_iter()
            .filter_map(|path| {
                self.pending_changes
                    .remove(&path)
                    .map(|pending| pending.event)
            })
            .collect()
    }

    fn next_wait(&self, now: Instant) -> Option<Duration> {
        self.pending_changes
            .values()
            .map(|pending| pending.reconcile_at.saturating_duration_since(now))
            .min()
    }

    fn cancel(&mut self) {
        self.pending_changes.clear();
    }
}

enum LoopInput {
    Event(Event),
    Deadline,
    Stop,
    Disconnected,
}

struct LoopStep {
    events: Vec<Event>,
    stop: bool,
}

fn advance_loop(coalescer: &mut EventCoalescer, input: LoopInput, now: Instant) -> LoopStep {
    match input {
        LoopInput::Event(event) => LoopStep {
            events: coalescer.push(event, now),
            stop: false,
        },
        LoopInput::Deadline => LoopStep {
            events: coalescer.flush_expired(now),
            stop: false,
        },
        LoopInput::Stop | LoopInput::Disconnected => {
            coalescer.cancel();
            LoopStep {
                events: Vec::new(),
                stop: true,
            }
        }
    }
}

pub fn content_hash(input: &str) -> String {
    let hash = input
        .encode_utf16()
        .fold(FNV_OFFSET_BASIS_64, |hash, unit| {
            (hash ^ u64::from(unit)).wrapping_mul(FNV_PRIME_64)
        });
    format!("{hash:016x}")
}

fn event_subscriptions(event: &WatchEvent, subscriptions: &[WatchSubscription]) -> Vec<String> {
    let path = Path::new(&event.path);
    subscriptions
        .iter()
        .filter(|subscription| subscription.includes(path))
        .map(|subscription| subscription.id.clone())
        .collect()
}

fn map_event(event: Event, subscriptions: &[WatchSubscription]) -> Vec<WatchEvent> {
    let mut events = match event.kind {
        EventKind::Create(_) => event
            .paths
            .into_iter()
            .map(|path| WatchEvent {
                kind: "create".to_string(),
                path: path.to_string_lossy().to_string(),
                ..Default::default()
            })
            .collect(),
        EventKind::Remove(_) => event
            .paths
            .into_iter()
            .map(|path| WatchEvent {
                kind: "remove".to_string(),
                path: path.to_string_lossy().to_string(),
                ..Default::default()
            })
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if event.paths.len() >= 2 => {
            vec![WatchEvent {
                kind: "rename".to_string(),
                old_path: Some(event.paths[0].to_string_lossy().to_string()),
                path: event.paths[1].to_string_lossy().to_string(),
                ..Default::default()
            }]
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => event
            .paths
            .into_iter()
            .map(|path| WatchEvent {
                kind: "remove".to_string(),
                path: path.to_string_lossy().to_string(),
                ..Default::default()
            })
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => event
            .paths
            .into_iter()
            .map(|path| WatchEvent {
                kind: "create".to_string(),
                path: path.to_string_lossy().to_string(),
                ..Default::default()
            })
            .collect(),
        EventKind::Modify(_) | EventKind::Access(AccessKind::Close(AccessMode::Write)) => event
            .paths
            .into_iter()
            .map(|path| WatchEvent {
                kind: "modify".to_string(),
                path: path.to_string_lossy().to_string(),
                ..Default::default()
            })
            .collect(),
        _ => Vec::new(),
    };
    for event in &mut events {
        event.subscriptions = event_subscriptions(event, subscriptions);
    }
    events.retain(|event| !event.subscriptions.is_empty());
    events
}

fn enrich_event(
    mut event: WatchEvent,
    pending_write_hashes: &Mutex<HashMap<PathBuf, String>>,
) -> WatchEvent {
    if event.kind == "remove" {
        return event;
    }

    let path = Path::new(&event.path);
    let Ok(metadata) = std::fs::metadata(path) else {
        return event;
    };
    event.size = Some(metadata.len());
    event.mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| u64::try_from(duration.as_millis()).ok());

    if metadata.is_file() {
        if let Ok(content) = std::fs::read_to_string(path) {
            event.content_hash = Some(content_hash(&content));
            if let Some(hash) = event.content_hash.as_ref() {
                if let Ok(mut pending) = pending_write_hashes.lock() {
                    if let Some(expected_hash) = pending.remove(path) {
                        event.self_authored = expected_hash == *hash;
                    }
                }
            }
            if metadata.len() <= INLINE_CONTENT_BYTES {
                event.content = Some(content);
            }
        }
    }

    event
}

#[derive(Default)]
pub struct WatchService {
    controller: Mutex<Option<WatchController>>,
    generation: Arc<WatchGeneration>,
    pending_write_hashes: Arc<Mutex<HashMap<PathBuf, String>>>,
}

impl WatchService {
    pub fn register_self_write(
        &self,
        path: impl Into<PathBuf>,
        hash: String,
    ) -> Result<(), String> {
        self.pending_write_hashes
            .lock()
            .map_err(|error| error.to_string())?
            .insert(path.into(), hash);
        Ok(())
    }

    pub fn forget_self_write(&self, path: &Path, hash: &str) {
        if let Ok(mut pending) = self.pending_write_hashes.lock() {
            if pending
                .get(path)
                .is_some_and(|pending_hash| pending_hash == hash)
            {
                pending.remove(path);
            }
        }
    }

    pub fn start<F>(
        &self,
        root: impl Into<PathBuf>,
        subscriptions: Vec<WatchSubscription>,
        on_batch: F,
    ) -> Result<WatchStatus, String>
    where
        F: Fn(WatchBatch) + Send + Sync + 'static,
    {
        let (root, subscriptions) = validate_watch_scope(root.into(), subscriptions)?;
        let baseline_generation = self.generation.current();
        let mut controller = self.controller.lock().map_err(|error| error.to_string())?;
        if let Some(existing) = controller.take() {
            existing.stop();
        }
        self.pending_write_hashes
            .lock()
            .map_err(|error| error.to_string())?
            .clear();

        let (stop_tx, event_rx) = mpsc::channel();
        let watcher_tx = stop_tx.clone();
        let generation = self.generation.clone();
        let pending_write_hashes = self.pending_write_hashes.clone();
        let on_batch = Arc::new(on_batch);
        let failure_callback = on_batch.clone();

        let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |result| {
            let _ = watcher_tx.send(WatcherMessage::Event(result));
        })
        .map_err(|error| format!("failed to create vault watcher: {error}"))?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|error| format!("failed to watch vault path {}: {error}", root.display()))?;

        let join_handle = std::thread::spawn(move || {
            let _watcher = watcher;
            let mut coalescer = EventCoalescer::default();
            loop {
                let now = Instant::now();
                let received = match coalescer.next_wait(now) {
                    Some(wait) => event_rx.recv_timeout(wait),
                    None => event_rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
                };
                let input = match received {
                    Ok(WatcherMessage::Event(Ok(event))) => LoopInput::Event(event),
                    Ok(WatcherMessage::Event(Err(error))) => {
                        eprintln!("vault watcher event error: {error}");
                        failure_callback(WatchBatch {
                            generation: generation.current(),
                            alive: false,
                            events: Vec::new(),
                        });
                        break;
                    }
                    Ok(WatcherMessage::Stop) => LoopInput::Stop,
                    Err(RecvTimeoutError::Timeout) => LoopInput::Deadline,
                    Err(RecvTimeoutError::Disconnected) => {
                        failure_callback(WatchBatch {
                            generation: generation.current(),
                            alive: false,
                            events: Vec::new(),
                        });
                        LoopInput::Disconnected
                    }
                };
                let step = advance_loop(&mut coalescer, input, Instant::now());
                if step.stop {
                    break;
                }
                let events = step
                    .events
                    .into_iter()
                    .flat_map(|event| map_event(event, &subscriptions))
                    .map(|event| enrich_event(event, &pending_write_hashes))
                    .collect::<Vec<_>>();
                if !events.is_empty() {
                    on_batch(WatchBatch {
                        generation: generation.next(),
                        alive: true,
                        events,
                    });
                }
            }
        });

        *controller = Some(WatchController {
            stop_tx,
            join_handle,
        });
        Ok(WatchStatus {
            generation: baseline_generation,
            alive: true,
            changed: false,
        })
    }

    pub fn status_since(&self, generation: u64) -> Result<WatchStatus, String> {
        let controller = self.controller.lock().map_err(|error| error.to_string())?;
        let alive = controller
            .as_ref()
            .is_some_and(|watcher| !watcher.join_handle.is_finished());
        Ok(self.generation.status_since(generation, alive))
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut controller = self.controller.lock().map_err(|error| error.to_string())?;
        if let Some(existing) = controller.take() {
            existing.stop();
        }
        self.pending_write_hashes
            .lock()
            .map_err(|error| error.to_string())?
            .clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, ModifyKind};

    fn event(kind: EventKind, paths: Vec<PathBuf>) -> Event {
        Event {
            kind,
            paths,
            attrs: Default::default(),
        }
    }

    #[test]
    fn subscriptions_are_exactly_path_filtered_and_can_exclude_a_subtree() {
        let root = PathBuf::from("/vault");
        let subscriptions = vec![
            WatchSubscription::new("vault", &root),
            WatchSubscription::new("covers", root.join("covers"))
                .excluding(root.join("covers/generated")),
        ];

        let recipe = map_event(
            event(
                EventKind::Create(CreateKind::File),
                vec![root.join("recipes/a.md")],
            ),
            &subscriptions,
        );
        let cover = map_event(
            event(
                EventKind::Create(CreateKind::File),
                vec![root.join("covers/soup.jpg")],
            ),
            &subscriptions,
        );
        let generated = map_event(
            event(
                EventKind::Create(CreateKind::File),
                vec![root.join("covers/generated/soup.jpg")],
            ),
            &subscriptions,
        );

        assert_eq!(recipe[0].subscriptions, vec!["vault"]);
        assert_eq!(cover[0].subscriptions, vec!["vault", "covers"]);
        assert_eq!(generated[0].subscriptions, vec!["vault"]);
    }

    #[test]
    fn close_write_settles_pending_change_without_waiting() {
        let now = Instant::now();
        let path = PathBuf::from("/vault/recipes/soup.md");
        let mut coalescer = EventCoalescer::default();
        assert!(coalescer
            .push(
                event(
                    EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                    vec![path.clone()],
                ),
                now,
            )
            .is_empty());

        let settled = coalescer.push(
            event(
                EventKind::Access(AccessKind::Close(AccessMode::Write)),
                vec![path],
            ),
            now,
        );
        assert_eq!(settled.len(), 1);
        assert!(matches!(settled[0].kind, EventKind::Modify(_)));
    }

    #[test]
    fn unmatched_change_reconciles_at_first_event_deadline() {
        let now = Instant::now();
        let path = PathBuf::from("/vault/recipes/soup.md");
        let mut coalescer = EventCoalescer::default();
        coalescer.push(
            event(
                EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                vec![path.clone()],
            ),
            now,
        );
        coalescer.push(
            event(
                EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                vec![path],
            ),
            now + Duration::from_millis(700),
        );

        assert_eq!(
            coalescer.flush_expired(now + RECONCILIATION_FALLBACK).len(),
            1
        );
    }

    #[test]
    fn cancellation_discards_pending_changes() {
        let now = Instant::now();
        let mut coalescer = EventCoalescer::default();
        coalescer.push(
            event(
                EventKind::Modify(ModifyKind::Any),
                vec![PathBuf::from("/vault/pending.md")],
            ),
            now,
        );
        let step = advance_loop(&mut coalescer, LoopInput::Stop, now);
        assert!(step.stop);
        assert!(step.events.is_empty());
        assert!(coalescer
            .flush_expired(now + RECONCILIATION_FALLBACK)
            .is_empty());
    }

    #[test]
    fn generation_reports_changed_and_explicit_dead_state() {
        let generation = WatchGeneration::default();
        assert_eq!(
            generation.status_since(0, false),
            WatchStatus {
                generation: 0,
                alive: false,
                changed: false,
            }
        );
        assert_eq!(generation.next(), 1);
        assert_eq!(
            generation.status_since(0, true),
            WatchStatus {
                generation: 1,
                alive: true,
                changed: true,
            }
        );
    }

    #[test]
    fn content_hash_matches_frontend_contract() {
        assert_eq!(content_hash(""), "cbf29ce484222325");
        assert_eq!(content_hash("recipe"), "69e752ffdb3f740f");
        assert_eq!(content_hash("café"), "b538f990e85962dc");
    }
}
