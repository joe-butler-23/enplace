import * as React from "react";
import { mergeText, type MergeResult } from "@/cookbook/merge";
import { parseRecipeDocument } from "@/recipe-document";
import { formatCookLogDate, parseCookLog } from "@/modules/cooking/services/RecipeLogService";
import {
  buildRecipeMeta,
  composeMarkdown,
  extractHeroImage,
  stripLeadingH1,
  stripStructuredSections
} from "../utils/recipe-frontmatter";
import { ReadDocument, ReadInline, type RecipeImageResources } from "./RecipeMarkdown";

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

/** Masthead image. Kept separate from body rendering so the cover paints with the first frame. */
function RecipeHero({ url, alt }: { url: string; alt: string }): React.ReactElement {
  return <div className="recipe-view__hero"><img src={url} alt={alt} decoding="sync" /></div>;
}

type RecipeSaveState = "clean" | "dirty" | "saving" | "saved" | "error";

/** Avoid reparsing Markdown when only checklist state changes. */
export const PreparedRecipeDocument = React.memo(ReadDocument);

/** One method step, memoised on its text so checkbox state never reparses it. */
export const StepText = React.memo(ReadInline);

type RecipeSaveNoticesProps = { enabled: boolean; state: RecipeSaveState; mergeConflict: boolean; deleteError?: boolean };
function RecipeSaveNotices({ enabled, state, mergeConflict, deleteError = false }: RecipeSaveNoticesProps): React.ReactElement {
  return <>
    {enabled && state !== "clean" ? (
      <div className="recipe-view__save-state" role="status" data-save-state={state}>
        {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "error" ? "Could not save changes" : "Unsaved changes"}
      </div>
    ) : null}
    {mergeConflict ? <div className="recipe-view__save-state" role="status" data-merge-conflict="true">
      Both versions kept where edits overlapped; look for the marked lines.
    </div> : null}
    {deleteError ? <div className="recipe-view__save-state" role="status">Could not delete recipe.</div> : null}
  </>;
}

type RecipeActionsProps = { isEditing: boolean; onEdit: () => void; onDone: () => void; onDelete?: () => Promise<void>; deleteRecipe: () => void };
/**
 * The recipe's page actions. One group, one style, one place in the layout: reading offers
 * Edit and Delete, editing offers Done, and the row never changes shape underneath them.
 */
function RecipeActions({ isEditing, onEdit, onDone, onDelete, deleteRecipe }: RecipeActionsProps): React.ReactElement {
  return <div className="recipe-view__actions">
    {isEditing
      ? <button className="recipe-view__action" type="button" onClick={onDone}>Done</button>
      : <>
        <button className="recipe-view__action" type="button" onClick={onEdit}>Edit</button>
        {onDelete ? <button className="recipe-view__action" type="button" onClick={deleteRecipe}>Delete recipe</button> : null}
      </>}
  </div>;
}

type RecipeMastheadProps = {
  title: string; meta: ReturnType<typeof buildRecipeMeta>; hero: ReturnType<typeof extractHeroImage>["hero"];
  heroUrl: string | null; actions: React.ReactNode;
};
function RecipeMasthead({ title, meta, hero, heroUrl, actions }: RecipeMastheadProps): React.ReactElement {
  return <header className={`recipe-view__masthead${hero ? "" : " recipe-view__masthead--textonly"}`}>
    <div className="recipe-view__masthead-text">
      <h1>{title}</h1>
      <div className="recipe-view__meta">
        <span className="recipe-view__source">
          {meta.source?.href ? <a href={meta.source.href} target="_blank" rel="noopener noreferrer">{meta.source.label}</a> : meta.source?.label}
        </span>
        {actions}
      </div>
    </div>
    {hero && heroUrl ? <RecipeHero url={heroUrl} alt={hero.alt} /> : null}
  </header>;
}

type RecipeReadContentProps = {
  ingredients: string[]; directions: string[]; checkedIngredients: Set<number>; checkedSteps: Set<number>;
  toggleIngredient: (index: number) => void; toggleStep: (index: number) => void; resetAll: () => void;
  readMarkdown: string; editor: React.ReactNode; cookLog: ReturnType<typeof parseCookLog>; tags: string[];
};
function RecipeReadContent({ ingredients, directions, checkedIngredients, checkedSteps, toggleIngredient,
  toggleStep, resetAll, readMarkdown, editor, cookLog, tags }: RecipeReadContentProps): React.ReactElement {
  return <>
    <aside className="recipe-view__panel recipe-view__ingredients-panel">
      <div className="recipe-view__panel-heading"><h2>Ingredients</h2></div>
      <ul className="recipe-view__checklist">
        {ingredients.map((ingredient, index) => (
          <li key={index}>
            <label>
              <input className="recipe-view__check" type="checkbox" checked={checkedIngredients.has(index)} onChange={() => toggleIngredient(index)} />
              <span className="checkbox-box" aria-hidden="true"><svg viewBox="0 0 12 12"><polyline points="2,6.4 4.7,9 10,3.2" /></svg></span>
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
            <button type="button" className="recipe-view__step-number" aria-pressed={checkedSteps.has(index)}
              aria-label={`Step ${index + 1}`} onClick={() => toggleStep(index)}>
              {String(index + 1).padStart(2, "0")}
            </button>
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
          <span className="recipe-view__cooklog-summary">{cookLog.length === 1 ? "1 cook" : `${cookLog.length} cooks`} · last {formatCookLogDate(cookLog[0].date)}</span>
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
    {tags.length > 0 ? <ul className="recipe-view__tags">
      {tags.map((tag) => <li key={tag}>{tag}</li>)}
    </ul> : null}
  </>;
}

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

  const parsed = React.useMemo(() => parseRecipeDocument(path, draft), [draft, path]);
  const ingredients = parsed.view.ingredients;
  const directions = parsed.view.directions;

  React.useEffect(() => {
    if (draftRef.current !== lastSavedDraftRef.current) {
      if (content === draftRef.current) {
        lastSavedDraftRef.current = content;
        setSaveState("saved");
      }
      return;
    }
    setDraft(content);
    draftRef.current = content;
    // Ticks are keyed by index: only reset when the incoming content genuinely adds, removes,
    // or reorders ingredients/steps. An edit (e.g. a typo fix, or the autosave echo of one)
    // that leaves both lists element-wise identical must not wipe what the cook already ticked.
    const next = parseRecipeDocument(path, content);
    if (!parsedListsMatch(next.view.ingredients, ingredients)) setCheckedIngredients(new Set());
    if (!parsedListsMatch(next.view.directions, directions)) setCheckedSteps(new Set());
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

  const resolvedTitle = parsed.view.title || title;
  const body = parsed.body.trim() ? parsed.body : `# ${resolvedTitle}\n`;
  const editorMarkdown = body;
  const { hero, body: bodyWithoutHero } = React.useMemo(
    () => extractHeroImage(parsed, body),
    [body, parsed]
  );
  const heroUrl = React.useMemo(
    () => hero ? resolveImage(hero.src, path) : null,
    [hero, path, resolveImage]
  );
  const meta = React.useMemo(() => buildRecipeMeta(parsed), [parsed]);
  const cookLog = React.useMemo(() => parseCookLog(parsed.body), [parsed.body]);

  React.useLayoutEffect(() => {
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
  const editor = isEditing ? (
    <div className="recipe-view__editor">
      <textarea
        className="recipe-view__text-editor"
        aria-label={hasConflictMarkers ? "Recipe markdown with merge conflicts" : "Recipe markdown"}
        value={editorMarkdown}
        onChange={(event) => updateDraft(event.currentTarget.value)}
      />
    </div>
  ) : readDocument;
  const editRecipe = () => setIsEditing(true);
  const finishEditing = () => setIsEditing(false);
  const deleteRecipe = () => {
    if (!onDelete || !window.confirm(`Delete ${resolvedTitle.trim()}?`)) return;
    setDeleteError(false);
    void flushSave().then(onDelete).catch((error) => {
      setDeleteError(true);
      console.error("Could not delete recipe", { path, error });
    });
  };
  const notices = <RecipeSaveNotices enabled={Boolean(onSave)} state={saveState} mergeConflict={mergeConflict} />;
  const actions = <RecipeActions isEditing={isEditing} onEdit={editRecipe} onDone={finishEditing}
    onDelete={onDelete} deleteRecipe={deleteRecipe} />;

  if (mode === "rendered") {
    return (
      <section className="recipe-view recipe-view--rendered">
        <div className="recipe-view__meta">{actions}</div>
        <div className="recipe-view__mdx">{editor}</div>
        {notices}
      </section>
    );
  }

  return (
    <section className="recipe-view recipe-view--full">
      <div className="recipe-view__content recipe-view__content--full">
        <RecipeMasthead title={resolvedTitle} meta={meta} hero={hero} heroUrl={heroUrl} actions={actions} />
        {isEditing ? <div className="recipe-view__mdx recipe-view__mdx--full">{editor}</div> : (
          <RecipeReadContent ingredients={ingredients} directions={directions}
            checkedIngredients={checkedIngredients} checkedSteps={checkedSteps}
            toggleIngredient={toggleIngredient} toggleStep={toggleStep} resetAll={resetAll}
            readMarkdown={readMarkdown} editor={editor} cookLog={cookLog} tags={meta.tags} />
        )}
        <RecipeSaveNotices enabled={Boolean(onSave)} state={saveState} mergeConflict={mergeConflict} deleteError={deleteError} />
      </div>
    </section>
  );
});
