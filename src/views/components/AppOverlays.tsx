import * as React from "react";
import { CookbookPanel } from "@/cookbook/CookbookPanel";
import { Dialog } from "./Dialog";

export type Command = { id: string; label: string; action: () => void };
/** Enter runs the first match, so a typed prefix and Enter is the whole interaction. */
export function CommandPalette({ commands, query, onQuery, onClose }: { commands: Command[]; query: string; onQuery: (value: string) => void; onClose: () => void }): React.JSX.Element {
  const input = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { input.current?.focus(); }, []);
  const run = (command: Command): void => { command.action(); onClose(); };
  return <Dialog title="Commands" onClose={onClose}>
    <form className="mep-command" onSubmit={(event) => { event.preventDefault(); if (commands[0]) run(commands[0]); }}>
      <input ref={input} aria-label="Search commands" placeholder="Type a command…" value={query} onChange={(event) => onQuery(event.currentTarget.value)} />
      {commands.length === 0 ? <p className="mep-command__empty">No matches.</p> : <div className="mep-command__list">
        {commands.map((command) => <button key={command.id} type="button" className="mep-menu__item" onClick={() => run(command)}>{command.label}</button>)}
      </div>}
    </form>
  </Dialog>;
}
const SHORTCUTS: ReadonlyArray<readonly [React.ReactNode, string]> = [
  [<><kbd>Ctrl</kbd> <kbd>K</kbd></>, "Command palette (⌘ K on a Mac)"],
  [<kbd>?</kbd>, "This list"],
  [<kbd>Esc</kbd>, "Close a dialog or menu"],
  [<><kbd>Ctrl</kbd> click</>, "Open a recipe in the side pane"],
  [<><kbd>←</kbd> <kbd>→</kbd></>, "Move the focused planner card to the neighbouring column"],
  [<><kbd>Shift</kbd> drag</>, "Copy a planner card to another day instead of moving it"],
];
export function HelpDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  return <Dialog title="Keyboard shortcuts" onClose={onClose}>
    <dl className="mep-help">{SHORTCUTS.map(([keys, action], index) => <React.Fragment key={index}><dt>{keys}</dt><dd>{action}</dd></React.Fragment>)}</dl>
  </Dialog>;
}
type SettingsProps = { routePath: string; onClose: () => void };
export function SettingsDialog({ routePath, onClose }: SettingsProps): React.JSX.Element {
  return <Dialog title="Settings" onClose={onClose}><CookbookPanel routePath={routePath} /></Dialog>;
}
export function StartupFailure({ error, onRetry }: { error: string; onRetry: () => void }): React.JSX.Element {
  const copy = (): void => { void navigator.clipboard.writeText(`Enplace startup failed at ${new Date().toISOString()}\n${error}`).catch(() => undefined); };
  return <main className="mep-gate" role="alert"><section className="mep-gate__card">
    <h1>Enplace could not start</h1>
    <pre className="mep-gate__detail">{error}</pre>
    <div className="mep-gate__actions">
      <button type="button" className="mep-button" onClick={onRetry}>Retry</button>
      <button type="button" className="mep-button" onClick={copy}>Copy details</button>
    </div>
  </section></main>;
}
export function Notices({ notices }: { notices: { id: string; message: string }[] }): React.JSX.Element {
  return <div className="mep-notices" role="status" aria-live="polite" aria-atomic="true">{notices.map((notice) => <div key={notice.id} className="mep-toast">{notice.message}</div>)}</div>;
}
