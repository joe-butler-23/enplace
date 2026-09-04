import * as React from "react";
import { CookbookPanel } from "@/cookbook/CookbookPanel";
import { normalizeWeeklyColumnMinWidth } from "@/modules/organiser/utils/weekly-layout";
import { setIcon } from "@/platform-primitives";
import type { StandaloneSettings } from "@/standalone/settings";

export type Command = { id: string; label: string; action: () => void };
export function CommandPalette({ commands, query, onQuery, onClose }: { commands: Command[]; query: string; onQuery: (value: string) => void; onClose: () => void }): React.JSX.Element {
  const ref = React.useRef<HTMLDialogElement>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const previous = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.showModal(); input.current?.focus();
    return () => { if (ref.current?.open) ref.current.close(); if (previous.current?.isConnected) previous.current.focus(); };
  }, []);
  return <dialog ref={ref} className="mep-command" aria-labelledby="mep-command-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <h2 id="mep-command-title">Command palette</h2>
    <input ref={input} autoFocus aria-label="Search commands" placeholder="Type a command…" value={query} onChange={(event) => onQuery(event.target.value)} />
    <div className="mep-command__list">{commands.length === 0 ? <div className="mep-command__empty">No matches.</div> : commands.map((command) => <button key={command.id} type="button" onClick={() => { command.action(); onClose(); }}>{command.label}</button>)}</div>
  </dialog>;
}
export function HelpDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const ref = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => { ref.current?.showModal(); return () => { if (ref.current?.open) ref.current.close(); }; }, []);
  return <div className="mep-modal-overlay" onClick={onClose}><dialog ref={ref} className="mep-help" aria-label="Enplace help" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => event.stopPropagation()}>
    <div className="mep-help__header"><h3>Quick Help</h3><button type="button" className="mep-button" onClick={onClose}>Close</button></div>
    <div className="mep-help__hint">Press <kbd>?</kbd> to open or close this overlay.</div>
    <div className="mep-help__section"><h4>Core shortcuts</h4><ul><li><kbd>Ctrl/Cmd</kbd> + <kbd>K</kbd>: open command palette</li><li><kbd>Esc</kbd>: close open overlays and modals</li><li>Sidebar: Planner, Recipe Database, Shopping List, Settings</li></ul></div>
    <div className="mep-help__section"><h4>Planner basics</h4><ul><li>Drag cards between columns to schedule or re-plan.</li><li>Hold <kbd>Shift</kbd> while dragging to duplicate instead of move.</li><li>Hold <kbd>Ctrl/Cmd</kbd> when clicking a card to open in a split.</li></ul></div>
  </dialog></div>;
}
type SettingsProps = { settings: StandaloneSettings; onChange: (updates: Partial<StandaloneSettings>) => void | Promise<void>; onClose: () => void };
export function SettingsDialog({ settings, onChange, onClose }: SettingsProps): React.JSX.Element {
  const ref = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => { if (ref.current && !ref.current.open) ref.current.showModal(); }, []);
  return <dialog className="mep-dialog" ref={ref} aria-label="Settings" onClose={onClose} onClick={(event) => { if (event.target === ref.current) ref.current?.close(); }}><div className="mep-dialog__body">
    <button className="mep-dialog__close" type="button" onClick={() => ref.current?.close()} title="Close settings" ref={(element) => { if (element) setIcon(element, "x"); }} />
    <div className="mep-settings"><h2>Settings</h2><div className="mep-settings__grid">
      <label>Recipe sort<select value={settings.databaseSort} onChange={(event) => void onChange({ databaseSort: event.target.value as StandaloneSettings["databaseSort"] })}><option value="added-desc">Newest</option><option value="added-asc">Oldest</option><option value="title-asc">Title (A-Z)</option><option value="title-desc">Title (Z-A)</option><option value="scheduled-desc">Scheduled (latest)</option><option value="scheduled-asc">Scheduled (oldest)</option></select></label>
      <label>Marked recipes<select value={settings.databaseMarkedFilter} onChange={(event) => void onChange({ databaseMarkedFilter: event.target.value as StandaloneSettings["databaseMarkedFilter"] })}><option value="all">All</option><option value="marked">Marked</option><option value="unmarked">Unmarked</option></select></label>
      <label>Scheduled recipes<select value={settings.databaseScheduledFilter} onChange={(event) => void onChange({ databaseScheduledFilter: event.target.value as StandaloneSettings["databaseScheduledFilter"] })}><option value="all">All</option><option value="scheduled">Scheduled</option><option value="unscheduled">Unscheduled</option></select></label>
      <label>Marked column width<input type="number" min="180" max="520" value={settings.weeklyOrganiserMarkedWidth} onChange={(event) => void onChange({ weeklyOrganiserMarkedWidth: normalizeWeeklyColumnMinWidth(Number(event.target.value)) })} /></label>
    </div><CookbookPanel /></div>
  </div></dialog>;
}
export function StartupFailure({ phase, error, events, onRetry }: { phase: string; error: string; events: string[]; onRetry: () => void }): React.JSX.Element {
  const copy = async () => navigator.clipboard.writeText(["Enplace startup diagnostics", `timestamp: ${new Date().toISOString()}`, `phase: ${phase}`, `error: ${error}`, "events:", ...events].join("\n"));
  return <div className="mep-root"><div className="mep-shell mep-shell--loading"><div className="mep-loading mep-loading--error"><div className="mep-loading__title">Startup failed</div><div className="mep-loading__phase">{phase}</div><pre className="mep-loading__error">{error}</pre>{events.length ? <pre className="mep-loading__trace">{events.slice(-8).join("\n")}</pre> : null}<div className="mep-loading__actions"><button type="button" className="mep-button mep-button--ghost" onClick={onRetry}>Retry startup</button><button type="button" className="mep-button mep-button--ghost" onClick={() => void copy()}>Copy diagnostics</button></div></div></div></div>;
}
export function Notices({ notices }: { notices: { id: string; message: string }[] }): React.JSX.Element {
  return <div className="mep-notices" role="status" aria-live="polite" aria-atomic="true">{notices.map((notice) => <div key={notice.id} className="mep-notice">{notice.message}</div>)}</div>;
}
