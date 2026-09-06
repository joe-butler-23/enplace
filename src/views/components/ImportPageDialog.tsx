import * as React from "react";
import { setIcon } from "@/platform-primitives";
import { configuredImageEndpoint, configuredPageEndpoint, fetchImageBlob, fetchPageHtml } from "../../recipe-import/page-fetch";
import { importPageRecipes, readPageRecipes, type PageRecipe } from "../../recipe-import/page-import";

const notify = (message: string): void => { window.dispatchEvent(new CustomEvent("mep-notice", { detail: { message } })); };
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Fetches a recipe page through the relay, or reads a pasted or opened page, and adds the chosen recipes as new cookbook files. */
export function ImportPageDialog({ onClose, onImported }: { onClose: () => void; onImported: (paths: string[]) => void }): React.JSX.Element {
  const ref = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => { if (ref.current && !ref.current.open) ref.current.showModal(); }, []);
  const endpoint = React.useMemo(configuredPageEndpoint, []);
  const [address, setAddress] = React.useState("");
  const [sourceUrl, setSourceUrl] = React.useState("");
  const [html, setHtml] = React.useState("");
  const [recipes, setRecipes] = React.useState<PageRecipe[]>([]);
  const [selected, setSelected] = React.useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = React.useState<"" | "fetching" | "adding">("");
  const [status, setStatus] = React.useState("");
  const [error, setError] = React.useState("");

  const read = (nextHtml: string, nextUrl: string): void => {
    setError("");
    if (!nextHtml.trim()) { setRecipes([]); setSelected(new Set()); return; }
    try {
      const found = readPageRecipes(nextHtml, nextUrl);
      setRecipes(found);
      setSelected(new Set(found.filter((recipe) => recipe.markdown && !recipe.missing.length).map((recipe) => recipe.index)));
      setStatus(found.length ? `Found ${plural(found.length, "recipe")}.` : "No recipe was found on this page.");
    } catch (failure) {
      setRecipes([]); setSelected(new Set()); setStatus("");
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const fetchAddress = async (): Promise<void> => {
    if (!endpoint || !address.trim() || busy) return;
    setBusy("fetching"); setError(""); setStatus("Fetching the page…"); setRecipes([]); setSelected(new Set());
    try {
      const page = await fetchPageHtml(address, endpoint);
      setHtml(page.html); setSourceUrl(page.url);
      read(page.html, page.url);
    } catch (failure) {
      setStatus("");
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setBusy(""); }
  };
  const readFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try { const text = await file.text(); setHtml(text); setSourceUrl(address.trim()); read(text, address.trim()); }
    catch { setError("Could not read that file."); }
  };
  const toggle = (index: number, checked: boolean): void => {
    setSelected((current) => { const next = new Set(current); if (checked) next.add(index); else next.delete(index); return next; });
  };
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!recipes.length) { await fetchAddress(); return; }
    const chosen = recipes.filter((recipe) => selected.has(recipe.index));
    if (!chosen.length) return;
    setBusy("adding"); setError("");
    try {
      const imageEndpoint = configuredImageEndpoint();
      const results = await importPageRecipes(chosen, imageEndpoint ? (url) => fetchImageBlob(url, imageEndpoint) : undefined);
      const added = results.filter((result) => result.path !== null);
      const failed = results.filter((result) => result.error !== null);
      const pictured = added.filter((result) => result.cover).length;
      if (added.length) { notify(`Added ${plural(added.length, "recipe")}${pictured ? pictured === added.length ? (added.length === 1 ? " with its picture" : " with their pictures") : `, ${pictured} with a picture` : ""}${failed.length ? `; ${plural(failed.length, "recipe")} skipped` : ""}.`); onImported(added.map((result) => result.path!)); }
      if (failed.length) setError(failed.map((result) => `${result.title}: ${result.error}`).join("\n"));
      else ref.current?.close();
    } finally { setBusy(""); }
  };

  const count = selected.size;
  return <dialog className="mep-dialog" ref={ref} aria-label="Import from a web page" onClose={onClose} onClick={(event) => { if (event.target === ref.current) ref.current?.close(); }}><div className="mep-dialog__body">
    <div className="mep-dialog__header">
      <h2>Import from a web page</h2>
      <button className="mep-dialog__close" type="button" onClick={() => ref.current?.close()} title="Close import" ref={(element) => { if (element) setIcon(element, "x"); }} />
    </div>
    <form className="mep-import-page" onSubmit={(event) => void submit(event)}>
      <label>Recipe page address<input type="url" aria-label="Page address" value={address} placeholder="https://" autoFocus onChange={(event) => setAddress(event.currentTarget.value)} /></label>
      {endpoint
        ? <div className="mep-settings__actions"><button type="button" className="mep-button" disabled={!!busy || !address.trim()} onClick={() => void fetchAddress()}>{busy === "fetching" ? "Fetching…" : "Fetch page"}</button></div>
        : <p className="mep-import-page__meta">No relay is configured, so pages cannot be fetched here; paste the page's HTML below instead.</p>}
      {status ? <p className="mep-import-page__meta" role="status">{status}</p> : null}
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
      {recipes.length ? <div className="mep-settings__actions">
        <button type="submit" className="mep-button" disabled={!!busy || !count}>{busy === "adding" ? "Adding…" : count === 1 ? "Add recipe" : `Add ${count} recipes`}</button>
        <button type="button" className="mep-button mep-button--ghost" disabled={!!busy} onClick={() => ref.current?.close()}>Cancel</button>
      </div> : null}
      <details className="mep-import-page__fallback">
        <summary>Page can't be fetched? Paste its HTML or open a saved copy</summary>
        <label>Page HTML<textarea aria-label="Page HTML" value={html} spellCheck={false} onChange={(event) => { setHtml(event.currentTarget.value); setSourceUrl(address.trim()); read(event.currentTarget.value, address.trim()); }} /></label>
        <label>Saved page<input aria-label="Saved page file" type="file" accept=".html,.htm,text/html" onChange={(event) => { void readFile(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label>
        <p className="mep-import-page__meta">The address above labels the source{sourceUrl && sourceUrl !== address.trim() ? ` (currently ${sourceUrl})` : ""}.</p>
      </details>
    </form>
  </div></dialog>;
}
