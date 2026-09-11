import * as React from "react";
import { importPastedRecipe } from "../../recipe-import/paste-import";
import { Dialog } from "./Dialog";
import { ImportPageForm } from "./ImportPageForm";
import { SegmentedControl } from "./SegmentedControl";

const MODES = [["web", "Web page"], ["markdown", "Markdown"], ["file", "File"]] as const;

export function AddRecipeDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  // A dismissed import may finish, but it no longer owns the current popup.
  const active = React.useRef(true);
  React.useLayoutEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const close = (): void => { if (active.current) { active.current = false; onClose(); } };
  const [mode, setMode] = React.useState<typeof MODES[number][0]>("web");
  const [markdown, setMarkdown] = React.useState("");
  const [cover, setCover] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const readFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setError("");
    try { setMarkdown(await file.text()); }
    catch { setError("Could not read that Markdown file."); }
  };
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try { await importPastedRecipe({ markdown, cover }); close(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return <Dialog title="Add recipe" onClose={close}>
    <SegmentedControl label="Recipe source" options={MODES} value={mode} onChange={setMode} disabled={busy} />
    <div hidden={mode !== "web"}><ImportPageForm onClose={close} /></div>
    <form hidden={mode === "web"} className="mep-import-page" onSubmit={(event) => void submit(event)}>
      {mode === "file" ? <label>Markdown file<input aria-label="Recipe Markdown file" type="file" accept=".md,text/markdown,text/plain" onChange={(event) => void readFile(event.currentTarget.files?.[0])} /></label> : null}
      <label>Recipe Markdown<textarea aria-label="Recipe Markdown" value={markdown} onChange={(event) => setMarkdown(event.currentTarget.value)} required /></label>
      <label>Cover image (optional)<input aria-label="Recipe cover image" type="file" accept="image/*" onChange={(event) => setCover(event.currentTarget.files?.[0] ?? null)} /></label>
      {error ? <p className="mep-import-page__error" role="alert">{error}</p> : null}
      <div className="mep-settings__actions">
        <button type="submit" className="mep-button" disabled={busy}>{busy ? "Adding…" : "Add recipe"}</button>
        <button type="button" className="mep-button" disabled={busy} onClick={close}>Cancel</button>
      </div>
      <p className="mep-import-page__meta">Use <a href="https://recipemd.org/specification.html" target="_blank" rel="noreferrer">RecipeMD</a>, or ask a recipe assistant to produce it.</p>
    </form>
  </Dialog>;
}
