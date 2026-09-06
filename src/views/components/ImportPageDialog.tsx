import * as React from "react";
import { setIcon } from "@/platform-primitives";
import { importPageRecipes, readPageRecipes, type PageRecipe } from "../../recipe-import/page-import";

const notify = (message: string): void => { window.dispatchEvent(new CustomEvent("mep-notice", { detail: { message } })); };
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Reads every recipe a saved or pasted page publishes and adds the chosen ones as new cookbook files. */
export function ImportPageDialog({ onClose, onImported }: { onClose: () => void; onImported: (paths: string[]) => void }): React.JSX.Element {
  const ref = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => { if (ref.current && !ref.current.open) ref.current.showModal(); }, []);
  const [url, setUrl] = React.useState("");
  const [html, setHtml] = React.useState("");
  const [recipes, setRecipes] = React.useState<PageRecipe[]>([]);
  const [selected, setSelected] = React.useState<ReadonlySet<number>>(new Set());
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState("");

  const read = (nextHtml: string, nextUrl: string): void => {
    setError("");
    if (!nextHtml.trim()) { setRecipes([]); setSelected(new Set()); return; }
    try {
      const found = readPageRecipes(nextHtml, nextUrl);
      setRecipes(found);
      setSelected(new Set(found.filter((recipe) => recipe.markdown && !recipe.missing.length).map((recipe) => recipe.index)));
      if (!found.length) setError("No recipe was found on this page.");
    } catch (failure) {
      setRecipes([]); setSelected(new Set());
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const readFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try { const text = await file.text(); setHtml(text); read(text, url); }
    catch { setError("Could not read that file."); }
  };
  const toggle = (index: number, checked: boolean): void => {
    setSelected((current) => { const next = new Set(current); if (checked) next.add(index); else next.delete(index); return next; });
  };
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const chosen = recipes.filter((recipe) => selected.has(recipe.index));
    if (!chosen.length) return;
    setPending(true); setError("");
    try {
      const results = await importPageRecipes(chosen);
      const added = results.filter((result) => result.path !== null);
      const failed = results.filter((result) => result.error !== null);
      if (added.length) { notify(`Added ${plural(added.length, "recipe")}${failed.length ? `; ${plural(failed.length, "recipe")} skipped` : ""}.`); onImported(added.map((result) => result.path!)); }
      if (failed.length) setError(failed.map((result) => `${result.title}: ${result.error}`).join("\n"));
      else ref.current?.close();
    } finally { setPending(false); }
  };

  const count = selected.size;
  return <dialog className="mep-dialog" ref={ref} aria-label="Import from a web page" onClose={onClose} onClick={(event) => { if (event.target === ref.current) ref.current?.close(); }}><div className="mep-dialog__body">
    <div className="mep-dialog__header">
      <h2>Import from a web page</h2>
      <button className="mep-dialog__close" type="button" onClick={() => ref.current?.close()} title="Close import" ref={(element) => { if (element) setIcon(element, "x"); }} />
    </div>
    <form className="mep-import-page" onSubmit={(event) => void submit(event)}>
      <label>Page address (optional)<input type="url" aria-label="Page address" value={url} placeholder="https://" onChange={(event) => { setUrl(event.currentTarget.value); if (html.trim()) read(html, event.currentTarget.value); }} /></label>
      <label>Paste the page's HTML<textarea aria-label="Page HTML" value={html} spellCheck={false} onChange={(event) => { setHtml(event.currentTarget.value); read(event.currentTarget.value, url); }} /></label>
      <label>Or open a saved page<input aria-label="Saved page file" type="file" accept=".html,.htm,text/html" onChange={(event) => { void readFile(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label>
      {recipes.length ? <ul className="mep-import-page__recipes" aria-label="Recipes found">{recipes.map((recipe) => <li key={recipe.index} className="mep-import-page__recipe">
        <input type="checkbox" id={`import-page-${recipe.index}`} checked={selected.has(recipe.index)} disabled={!recipe.markdown} onChange={(event) => toggle(recipe.index, event.currentTarget.checked)} />
        <label htmlFor={`import-page-${recipe.index}`}>
          <strong>{recipe.title}</strong>
          <div className="mep-import-page__meta">{plural(recipe.ingredientCount, "ingredient")} · {plural(recipe.instructionCount, "step")}</div>
          {recipe.missing.length ? <div className="mep-import-page__warning">Missing {recipe.missing.join(" and ")}</div> : null}
          {recipe.error ? <div className="mep-import-page__warning">{recipe.error}</div> : null}
        </label>
      </li>)}</ul> : null}
      {error ? <p className="mep-import-page__error" role="alert">{error}</p> : null}
      <div className="mep-settings__actions">
        <button type="submit" className="mep-button" disabled={pending || !count}>{pending ? "Adding…" : count === 1 ? "Add recipe" : `Add ${count} recipes`}</button>
        <button type="button" className="mep-button mep-button--ghost" disabled={pending} onClick={() => ref.current?.close()}>Cancel</button>
      </div>
      <p className="mep-import-page__meta">Nothing is downloaded: the page is read from what you paste or open, and the address only labels the source.</p>
    </form>
  </div></dialog>;
}
