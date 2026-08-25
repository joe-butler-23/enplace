import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseIngredientsSection } from "@/modules/cooking/services/ingredient-parsing";
import {
  composeMarkdown,
  extractRecipeTitle,
  formatPropertyLabel,
  formatPropertyValue,
  getPropertyHref,
  normalizeFrontmatterValue,
  parseDirectionsSection,
  parseFrontmatter,
  stripLeadingH1
} from "../utils/recipe-frontmatter";
import type { ImageResource } from "../utils/image-resources";

type RecipeViewProps = {
  path: string;
  title: string;
  content: string;
  mode?: "full" | "rendered";
  onSave?: (nextContent: string) => Promise<void>;
  resolveImageResource?: (
    imagePath: string,
    sourcePath: string
  ) => Promise<ImageResource | null>;
  getImageResource?: (
    imagePath: string,
    sourcePath: string
  ) => ImageResource | undefined;
};

const AUTOSAVE_DEBOUNCE_MS = 350;

const LazyRecipeEditor = React.lazy(() => import("./RecipeEditor").then((module) => ({ default: module.RecipeEditor })));

function ReadImage({
  src,
  alt,
  imageTitle,
  path,
  resolveImageResource,
  getImageResource
}: {
  src: string;
  alt?: string;
  imageTitle?: string;
  path: string;
  resolveImageResource?: RecipeViewProps["resolveImageResource"];
  getImageResource?: RecipeViewProps["getImageResource"];
}): React.ReactElement {
  const [resource, setResource] = React.useState<ImageResource | null>(
    () => getImageResource?.(src, path) ?? null
  );
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    const cached = getImageResource?.(src, path) ?? null;
    if (cached) {
      setFailed(false);
      setResource(cached);
      return () => { cancelled = true; };
    }
    setFailed(false);
    setResource(null);
    const load = resolveImageResource
      ? resolveImageResource(src, path).then((value) => value ? value : null)
      : /^(https?:|data:|blob:|file:|asset:|app:|obsidian:)/i.test(src)
        ? Promise.resolve({ url: src, width: 16, height: 9 })
        : Promise.resolve(null);
    void load.then((value) => {
      if (!cancelled) setResource(value);
    }).catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => { cancelled = true; };
  }, [src, path, getImageResource, resolveImageResource]);

  return (
    <figure className="recipe-view__image">
      {resource ? (
        <img src={resource.url} alt={alt ?? ""} title={imageTitle} loading="eager" decoding="async" onError={() => setFailed(true)} />
      ) : failed ? (
        <div className="recipe-view__image-error" role="img" aria-label={`${alt || "Image"} unavailable`}>Image unavailable</div>
      ) : (
        <div className="recipe-view__image-placeholder" aria-hidden="true" />
      )}
    </figure>
  );
}

export function ReadDocument({
  markdown,
  path,
  resolveImageResource,
  getImageResource
}: {
  markdown: string;
  path: string;
  resolveImageResource?: RecipeViewProps["resolveImageResource"];
  getImageResource?: RecipeViewProps["getImageResource"];
}): React.ReactElement {
  return (
    <div className="recipe-view__read-document">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => url}
        components={{
          img: ({ src, alt, title }) => (
            <ReadImage src={src ?? ""} alt={alt} imageTitle={title} path={path} resolveImageResource={resolveImageResource} getImageResource={getImageResource} />
          )
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

export function RecipeView({
  path,
  title,
  content,
  mode = "full",
  onSave,
  resolveImageResource,
  getImageResource
}: RecipeViewProps): React.ReactElement {
  const [draft, setDraft] = React.useState(content);
  const [isEditing, setIsEditing] = React.useState(false);
  const [checkedIngredients, setCheckedIngredients] = React.useState<Set<number>>(new Set());
  const [activeStep, setActiveStep] = React.useState<number | null>(null);
  const isMountedRef = React.useRef(false);
  const autosaveTimerRef = React.useRef<number | null>(null);
  const lastSavedDraftRef = React.useRef(content);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
    };
  }, []);

  React.useEffect(() => {
    setDraft(content);
    setCheckedIngredients(new Set());
    setActiveStep(null);
    setIsEditing(false);
    lastSavedDraftRef.current = content;
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, [content, path]);

  const parsed = React.useMemo(() => parseFrontmatter(draft), [draft]);
  const ingredients = React.useMemo(() => parseIngredientsSection(parsed.body), [parsed.body]);
  const ingredientRows = React.useMemo(() => {
    const occurrences = new Map<string, number>();
    return ingredients.map((ingredient, index) => {
      const occurrence = occurrences.get(ingredient) ?? 0;
      occurrences.set(ingredient, occurrence + 1);
      return { ingredient, index, key: `${ingredient}:${occurrence}` };
    });
  }, [ingredients]);
  const directions = React.useMemo(() => parseDirectionsSection(parsed.body), [parsed.body]);
  const resolvedTitle = React.useMemo(() => {
    const frontmatterTitle = parsed.frontmatter.title;
    return typeof frontmatterTitle === "string" && frontmatterTitle.trim()
      ? frontmatterTitle.trim()
      : extractRecipeTitle(parsed.body, title);
  }, [parsed.body, parsed.frontmatter.title, title]);
  const body = parsed.body.trim() ? parsed.body : `# ${resolvedTitle}\n`;
  const editorMarkdown = body;
  const visibleProperties = React.useMemo(() => {
    const hiddenKeys = new Set(["title", "cover", "image"]);
    const priorityOrder = ["source", "scheduled", "added", "cooked", "tags", "type"];
    const rank = (key: string) => { const index = priorityOrder.indexOf(key); return index === -1 ? priorityOrder.length : index; };
    return Object.entries(parsed.frontmatter).flatMap(([key, value]) => {
      if (hiddenKeys.has(key)) return [];
      const normalized = normalizeFrontmatterValue(value);
      return normalized !== "" && normalized !== null && (!Array.isArray(normalized) || normalized.length > 0)
        ? [[key, normalized] as const]
        : [];
    })
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .slice(0, 10);
  }, [parsed.frontmatter]);

  React.useEffect(() => {
    if (!onSave || draft === lastSavedDraftRef.current) return;
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = window.setTimeout(() => {
      const nextContent = draft;
      if (nextContent === lastSavedDraftRef.current) return;
      void onSave(nextContent).then(() => {
        if (isMountedRef.current) lastSavedDraftRef.current = nextContent;
      }).catch((error) => console.error("Autosave failed for recipe", { path, error }));
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [draft, onSave, path]);

  const toggleIngredient = React.useCallback((index: number) => {
    setCheckedIngredients((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  }, []);

  const readMarkdown = mode === "full" ? stripLeadingH1(body) : body;
  const readDocument = <ReadDocument markdown={readMarkdown} path={path} resolveImageResource={resolveImageResource} getImageResource={getImageResource} />;
  const editor = isEditing ? (
    <React.Suspense fallback={<div className="recipe-view__editor-loading">Loading editor…</div>}>
      <LazyRecipeEditor
        path={path}
        markdown={editorMarkdown}
        onChange={(nextMarkdown: string) => {
          setDraft(composeMarkdown(parsed.rawFrontmatter, nextMarkdown));
        }}
        onClose={() => setIsEditing(false)}
      />
    </React.Suspense>
  ) : readDocument;

  const contentPane = mode === "rendered" ? (
    <section className="recipe-view recipe-view--rendered">
      <div className={`recipe-view__rendered-content ${isEditing ? "is-editing" : ""}`}>
        <div className="recipe-view__mdx">{editor}</div>
        {!isEditing ? <button className="recipe-view__edit-action" type="button" onClick={() => setIsEditing(true)}>Edit</button> : null}
      </div>
    </section>
  ) : (
    <section className="recipe-view recipe-view--full">
      <div className="recipe-view__content recipe-view__content--full">
        <aside className="recipe-view__panel recipe-view__ingredients-panel">
          <div className="recipe-view__sticky-container">
            <h3>Ingredients</h3>
            <ul className="recipe-view__checklist">
              {ingredientRows.map(({ ingredient, index, key }) => (
                <li key={key}><label><input type="checkbox" checked={checkedIngredients.has(index)} onChange={() => toggleIngredient(index)} /><span className={checkedIngredients.has(index) ? "is-checked" : ""}>{ingredient}</span></label></li>
              ))}
            </ul>
            {directions.length > 0 ? <span className="recipe-view__steps-count">{directions.length} steps</span> : null}
          </div>
        </aside>
        <article className="recipe-view__panel recipe-view__method-pane">
          <div className="recipe-view__method-heading">
            <h1>{resolvedTitle}</h1>
            {!isEditing ? <button className="recipe-view__edit-action" type="button" onClick={() => setIsEditing(true)}>Edit</button> : null}
          </div>
          {visibleProperties.length > 0 ? <dl className="recipe-view__meta-grid">{visibleProperties.map(([key, value]) => {
            const href = getPropertyHref(key, value);
            return <div key={key} className="recipe-view__meta-card"><dt className="recipe-view__meta-label">{formatPropertyLabel(key)}</dt><dd className="recipe-view__meta-value">{href ? <a className="recipe-view__meta-link" href={href} target="_blank" rel="noopener noreferrer">{formatPropertyValue(key, value)}</a> : formatPropertyValue(key, value)}</dd></div>;
          })}</dl> : null}
          <div className="recipe-view__mdx recipe-view__mdx--full">{editor}</div>
          {activeStep !== null ? <span className="recipe-view__active-step" aria-hidden="true">{activeStep}</span> : null}
        </article>
      </div>
    </section>
  );
  return contentPane;
}
