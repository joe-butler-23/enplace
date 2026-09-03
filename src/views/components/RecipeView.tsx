import * as React from "react";
import { mergeText, type MergeResult } from "@/kitchen/merge";
import { parseIngredientsSection } from "@/modules/cooking/services/recipe-section-parsing";
import { formatCookLogDate, parseCookLog } from "@/modules/cooking/services/RecipeLogService";
import {
  buildRecipeMeta,
  composeMarkdown,
  extractHeroImage,
  extractRecipeTitle,
  parseDirectionsSection,
  parseFrontmatter,
  stripLeadingH1,
  stripStructuredSections,
  stripWrappedQuotes
} from "../utils/recipe-frontmatter";
import type { RecipeImageResources } from "./RecipeMarkdown";

type RecipeViewProps = RecipeImageResources & {
  path: string;
  title: string;
  content: string;
  mode?: "full" | "rendered";
  onSave?: (baseContent: string, nextContent: string) => Promise<MergeResult>;
  onDelete?: () => Promise<void>;
};

export type RecipeViewHandle = {
  flushSave: () => Promise<void>;
};

const AUTOSAVE_DEBOUNCE_MS = 350;

function toggleIndex(previous: Set<number>, index: number): Set<number> {
  const next = new Set(previous);
  if (next.has(index)) next.delete(index); else next.add(index);
  return next;
}

/**
 * True when two parsed ingredient/step lists are element-wise identical. Checked state is
 * keyed by index, so a genuine gain/loss/reorder makes the old indices meaningless (reset is
 * correct); an unchanged list must not wipe ticks just because the surrounding content changed.
 */
export function parsedListsMatch(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

let nextRecipeSelectionGeneration = 0;

export function recipeHeroTimingIdentifier(selectionGeneration: number, path: string): string {
  return `mep:recipe-hero:${selectionGeneration}:${path}`;
}

/** Masthead image. Kept out of the lazy markdown chunk so a warm cover paints with the first frame. */
function RecipeHero({ url, alt, timingIdentifier }: { url: string; alt: string; timingIdentifier: string }): React.ReactElement {
  return (
    <div className="recipe-view__hero">
      <img
        {...({
          src: url,
          alt,
          fetchPriority: "high",
          decoding: "async",
          elementtiming: timingIdentifier,
        } as React.ImgHTMLAttributes<HTMLImageElement>)}
      />
    </div>
  );
}

type RecipeSaveState = "clean" | "dirty" | "saving" | "saved" | "error";

const LazyRecipeEditor = React.lazy(() => import("./RecipeEditor").then((module) => ({ default: module.RecipeEditor })));
let recipeMarkdownModule: Promise<typeof import("./RecipeMarkdown")> | null = null;
let PreparedReadDocument: typeof import("./RecipeMarkdown").ReadDocument | null = null;
let PreparedReadInline: typeof import("./RecipeMarkdown").ReadInline | null = null;
export function prepareRecipeMarkdown() {
  recipeMarkdownModule ??= import("./RecipeMarkdown").then((module) => {
    PreparedReadDocument = module.ReadDocument;
    PreparedReadInline = module.ReadInline;
    return module;
  });
  return recipeMarkdownModule;
}

/** Resolves to the lazily-loaded component once `prepareRecipeMarkdown` has settled. */
function useLazyMarkdownComponent<C>(read: () => C | null): C | null {
  const [Component, setComponent] = React.useState(read);
  React.useEffect(() => {
    if (Component) return;
    void prepareRecipeMarkdown().then(() => setComponent(() => read()));
  }, [Component]);
  return Component;
}

/**
 * Memoised on its own props so an unrelated RecipeView re-render (a checkbox toggle) does not
 * re-invoke react-markdown, which builds a fresh unified processor and fully reparses every call.
 */
export const PreparedRecipeDocument = React.memo(function PreparedRecipeDocument(
  props: RecipeImageResources & { markdown: string; path: string }
) {
  const Component = useLazyMarkdownComponent(() => PreparedReadDocument);
  return Component ? <Component {...props} /> : null;
});

/**
 * One method step, memoised on its step text alone: toggling that step's own checkbox (or any
 * other step's) changes the wrapping `<span>` class but not this prop, so it bails without
 * re-parsing — the fix for N-parses-per-toggle. Falls back to literal text until the markdown
 * chunk loads, matching the notes renderer below.
 */
export const StepText = React.memo(function StepText({ text }: { text: string }) {
  const Component = useLazyMarkdownComponent(() => PreparedReadInline);
  return Component ? <Component text={text} /> : <>{text}</>;
});

export const RecipeView = React.forwardRef<RecipeViewHandle, RecipeViewProps>(function RecipeView({
  path,
  title,
  content,
  mode = "full",
  onSave,
  onDelete,
  resolveImage
}: RecipeViewProps, ref): React.ReactElement {
  const [draft, setDraft] = React.useState(content);
  const [isEditing, setIsEditing] = React.useState(false);
  const [checkedIngredients, setCheckedIngredients] = React.useState<Set<number>>(new Set());
  const [checkedSteps, setCheckedSteps] = React.useState<Set<number>>(new Set());
  const [saveState, setSaveState] = React.useState<RecipeSaveState>("clean");
  const [mergeConflict, setMergeConflict] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState(false);
  const [editorResetRevision, setEditorResetRevision] = React.useState(0);
  const [selectionGeneration] = React.useState(() => ++nextRecipeSelectionGeneration);
  const isMountedRef = React.useRef(false);
  const autosaveTimerRef = React.useRef<number | null>(null);
  const lastSavedDraftRef = React.useRef(content);
  const draftRef = React.useRef(content);
  const saveInFlightRef = React.useRef<Promise<void> | null>(null);

  const flushSave = React.useCallback(() => {
    if (!onSave || draftRef.current === lastSavedDraftRef.current) return Promise.resolve();
    if (saveInFlightRef.current) return saveInFlightRef.current;
    const operation = (async () => {
      let operationHadConflict = false;
      while (draftRef.current !== lastSavedDraftRef.current) {
        const baseContent = lastSavedDraftRef.current;
        const nextContent = draftRef.current;
        if (isMountedRef.current) setSaveState("saving");
        try {
          const result = await onSave(baseContent, nextContent);
          const pendingDraft = draftRef.current;
          const rebased = pendingDraft === nextContent
            ? result
            : mergeText(nextContent, pendingDraft, result.text);
          operationHadConflict ||= result.conflicts > 0 || rebased.conflicts > 0;
          lastSavedDraftRef.current = result.text;
          draftRef.current = rebased.text;
          if (isMountedRef.current) {
            setDraft(rebased.text);
            if (rebased.text !== pendingDraft) setEditorResetRevision((revision) => revision + 1);
          }
        } catch (error) {
          if (isMountedRef.current) setSaveState("error");
          throw error;
        }
      }
      if (isMountedRef.current) {
        setMergeConflict(operationHadConflict);
        setSaveState("saved");
      }
    })().finally(() => { saveInFlightRef.current = null; });
    saveInFlightRef.current = operation;
    return operation;
  }, [onSave]);

  React.useImperativeHandle(ref, () => ({ flushSave }), [flushSave]);

  React.useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (draftRef.current === lastSavedDraftRef.current && saveInFlightRef.current === null) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, []);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    };
  }, []);

  const parsed = React.useMemo(() => parseFrontmatter(draft), [draft]);
  const ingredients = React.useMemo(() => parseIngredientsSection(parsed.body), [parsed.body]);
  const directions = React.useMemo(() => parseDirectionsSection(parsed.body), [parsed.body]);

  React.useEffect(() => {
    if (draftRef.current !== lastSavedDraftRef.current) {
      if (content === draftRef.current) {
        lastSavedDraftRef.current = content;
        setSaveState("saved");
      }
      return;
    }
    const previousDraft = draftRef.current;
    setDraft(content);
    draftRef.current = content;
    if (isEditing && previousDraft !== content) setEditorResetRevision((revision) => revision + 1);
    // Ticks are keyed by index: only reset when the incoming content genuinely adds, removes,
    // or reorders ingredients/steps. An edit (e.g. a typo fix, or the autosave echo of one)
    // that leaves both lists element-wise identical must not wipe what the cook already ticked.
    const nextBody = parseFrontmatter(content).body;
    if (!parsedListsMatch(parseIngredientsSection(nextBody), ingredients)) setCheckedIngredients(new Set());
    if (!parsedListsMatch(parseDirectionsSection(nextBody), directions)) setCheckedSteps(new Set());
    lastSavedDraftRef.current = content;
    setSaveState("clean");
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    // Deliberately keyed on `content` alone: `ingredients`/`directions` are read as the
    // lists-before-this-update (this render's values, derived from the still-old `draft`) to
    // compare against the lists implied by the incoming content. Adding them as dependencies
    // would make the effect re-fire the moment `draft` catches up to `content` above, since a
    // fresh parse always returns a new array reference even when its contents are unchanged.
  }, [content]);

  const resolvedTitle = React.useMemo(() => {
    const frontmatterTitle = typeof parsed.frontmatter.title === "string"
      ? stripWrappedQuotes(parsed.frontmatter.title.trim()).trim()
      : "";
    return frontmatterTitle || extractRecipeTitle(parsed.body, title);
  }, [parsed.body, parsed.frontmatter.title, title]);
  const body = parsed.body.trim() ? parsed.body : `# ${resolvedTitle}\n`;
  const editorMarkdown = body;
  const { hero, body: bodyWithoutHero } = React.useMemo(
    () => extractHeroImage(body, parsed.frontmatter),
    [body, parsed.frontmatter]
  );
  const heroUrl = React.useMemo(
    () => hero ? resolveImage(hero.src, path) : null,
    [hero, path, resolveImage]
  );
  const heroIdentifier = heroUrl ? recipeHeroTimingIdentifier(selectionGeneration, path) : null;
  React.useEffect(() => {
    if (mode !== "full" || typeof performance === "undefined" || typeof performance.mark !== "function") return;
    performance.mark("mep:recipe:semantic-ready", {
      detail: {
        path,
        title: resolvedTitle,
        hasHero: Boolean(heroUrl),
        heroIdentifier,
        heroUrl,
        mode,
        selectionGeneration,
      }
    });
  }, [heroIdentifier, heroUrl, mode, path, resolvedTitle, selectionGeneration]);
  const meta = React.useMemo(() => buildRecipeMeta(parsed.frontmatter), [parsed.frontmatter]);
  const cookLog = React.useMemo(() => parseCookLog(parsed.body), [parsed.body]);

  React.useEffect(() => {
    if (!onSave || draft === lastSavedDraftRef.current) return;
    draftRef.current = draft;
    setSaveState("dirty");
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void flushSave().catch((error) => console.error("Autosave failed for recipe", { path, error }));
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [draft, flushSave, onSave, path]);

  const toggleIngredient = React.useCallback((index: number) => {
    setCheckedIngredients((previous) => toggleIndex(previous, index));
  }, []);
  const toggleStep = React.useCallback((index: number) => {
    setCheckedSteps((previous) => toggleIndex(previous, index));
  }, []);
  const resetAll = React.useCallback(() => {
    setCheckedIngredients(new Set());
    setCheckedSteps(new Set());
  }, []);

  const readMarkdown = React.useMemo(
    () => (mode === "full" ? stripLeadingH1(stripStructuredSections(bodyWithoutHero)).trim() : body),
    [mode, bodyWithoutHero, body]
  );
  const readDocument = <PreparedRecipeDocument markdown={readMarkdown} path={path} resolveImage={resolveImage} />;
  const updateDraft = React.useCallback((nextMarkdown: string) => {
    setDraft(composeMarkdown(parsed.rawFrontmatter, nextMarkdown));
  }, [parsed.rawFrontmatter]);
  const hasConflictMarkers = draft.includes("<<<<<<< this device\n")
    && draft.includes("\n=======\n")
    && draft.includes("\n>>>>>>>>");
  const editor = isEditing ? hasConflictMarkers ? (
    <div className="recipe-view__editor">
      <div className="recipe-view__editor-actions"><button type="button" onClick={() => setIsEditing(false)}>Done</button></div>
      <textarea
        className="recipe-view__conflict-editor"
        aria-label="Recipe markdown with merge conflicts"
        value={editorMarkdown}
        onChange={(event) => updateDraft(event.currentTarget.value)}
      />
    </div>
  ) : (
    <React.Suspense fallback={null}>
      <LazyRecipeEditor
        key={`${path}:${editorResetRevision}`}
        path={path}
        markdown={editorMarkdown}
        onChange={updateDraft}
        onClose={() => setIsEditing(false)}
      />
    </React.Suspense>
  ) : readDocument;
  const saveIndicator = onSave && saveState !== "clean" ? (
    <div className="recipe-view__save-state" role="status" data-save-state={saveState}>
      {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Could not save changes" : "Unsaved changes"}
    </div>
  ) : null;
  const conflictNotice = mergeConflict ? (
    <div className="recipe-view__save-state" role="status" data-merge-conflict="true">
      Both versions kept where edits overlapped; look for the marked lines.
    </div>
  ) : null;

  const contentPane = mode === "rendered" ? (
    <section className="recipe-view recipe-view--rendered">
      <div className={`recipe-view__rendered-content ${isEditing ? "is-editing" : ""}`}>
        <div className="recipe-view__mdx">{editor}</div>
        {saveIndicator}
        {conflictNotice}
        {!isEditing ? <button className="recipe-view__edit-action" type="button" onClick={() => setIsEditing(true)}>Edit</button> : null}
      </div>
    </section>
  ) : (
    <section className="recipe-view recipe-view--full">
      <div className="recipe-view__content recipe-view__content--full">
        <header className={`recipe-view__masthead${hero ? "" : " recipe-view__masthead--textonly"}`}>
          <div className="recipe-view__masthead-text">
            <h1>{resolvedTitle}</h1>
            <div className="recipe-view__meta">
              <span className="recipe-view__source">
                {meta.source?.href
                  ? <a href={meta.source.href} target="_blank" rel="noopener noreferrer">{meta.source.label}</a>
                  : meta.source?.label}
              </span>
              {!isEditing ? <button className="recipe-view__edit-action" type="button" onClick={() => setIsEditing(true)}>Edit</button> : null}
              {onDelete && !isEditing ? <button className="recipe-view__edit-action" type="button" onClick={() => {
                if (!window.confirm(`Delete ${resolvedTitle.trim()}?`)) return;
                setDeleteError(false);
                void flushSave().then(onDelete).catch((error) => {
                  setDeleteError(true);
                  console.error("Could not delete recipe", { path, error });
                });
              }}>Delete recipe</button> : null}
            </div>
          </div>
          {hero && heroUrl && heroIdentifier ? <RecipeHero url={heroUrl} alt={hero.alt} timingIdentifier={heroIdentifier} /> : null}
        </header>

        {isEditing ? <div className="recipe-view__mdx recipe-view__mdx--full">{editor}</div> : (
          <>
            <aside className="recipe-view__panel recipe-view__ingredients-panel">
              <div className="recipe-view__panel-heading">
                <h2>Ingredients</h2>
              </div>
              <ul className="recipe-view__checklist">
                {ingredients.map((ingredient, index) => (
                  <li key={index}>
                    <label>
                      <input className="recipe-view__check" type="checkbox" checked={checkedIngredients.has(index)} onChange={() => toggleIngredient(index)} />
                      <span className="checkbox-box" aria-hidden="true">
                        <svg viewBox="0 0 12 12"><polyline points="2,6.4 4.7,9 10,3.2" /></svg>
                      </span>
                      <span className={checkedIngredients.has(index) ? "is-checked" : ""}>{ingredient}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </aside>
            <article className="recipe-view__panel recipe-view__method">
              <div className="recipe-view__panel-heading">
                <h2>Method</h2>
                <button className="recipe-view__reset" type="button" onClick={resetAll}>Reset</button>
              </div>
              <ol className="recipe-view__checklist recipe-view__checklist--steps">
                {directions.map((step, index) => (
                  <li key={index}>
                    <button
                      type="button"
                      className="recipe-view__step-number"
                      aria-pressed={checkedSteps.has(index)}
                      aria-label={`Step ${index + 1}`}
                      onClick={() => toggleStep(index)}
                    >{String(index + 1).padStart(2, "0")}</button>
                    <p className={`recipe-view__step-text${checkedSteps.has(index) ? " is-checked" : ""}`}><StepText text={step} /></p>
                  </li>
                ))}
              </ol>
            </article>
            {readMarkdown ? <div className="recipe-view__notes recipe-view__mdx recipe-view__mdx--full">{editor}</div> : null}
            {cookLog.length > 0 ? (
              <details className="recipe-view__cooklog">
                <summary>
                  <span className="recipe-view__cooklog-label">Cook log</span>
                  <span className="recipe-view__cooklog-summary">
                    {cookLog.length === 1 ? "1 cook" : `${cookLog.length} cooks`} · last {formatCookLogDate(cookLog[0].date)}
                  </span>
                </summary>
                <ul>
                  {cookLog.map((entry, index) => {
                    const verdict = [
                      entry.rating === null ? null : `Rated ${entry.rating}`,
                      entry.makeAgain === null ? null : entry.makeAgain ? "Would make again" : "Would not make again"
                    ].filter(Boolean).join(" · ");
                    return (
                      <li key={`${entry.date}:${index}`}>
                        <span className="recipe-view__cooklog-date">{formatCookLogDate(entry.date)}</span>
                        <div className="recipe-view__cooklog-entry">
                          {entry.notes ? <p>{entry.notes}</p> : null}
                          {verdict ? <p className="recipe-view__cooklog-verdict">{verdict}</p> : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </details>
            ) : null}
            {meta.tags.length > 0 ? (
              <ul className="recipe-view__tags">
                {meta.tags.map((tag) => <li key={tag}>{tag}</li>)}
              </ul>
            ) : null}
          </>
        )}
        {saveIndicator}
        {conflictNotice}
        {deleteError ? <div className="recipe-view__save-state" role="status">Could not delete recipe.</div> : null}
      </div>
    </section>
  );
  return contentPane;
});
