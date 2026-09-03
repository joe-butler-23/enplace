import * as React from "react";
import { useEffectEvent } from "@/shared/use-effect-event";
import { RecipeIndexItem, RecipeIndexSort } from "../../modules/cooking/types";
import { importPastedRecipe, PasteRecipeInput } from "../../recipe-import/paste-import";

export type MarkedFilter = "all" | "marked" | "unmarked";
export type ScheduledFilter = "all" | "scheduled" | "unscheduled";
export type AddedFilter = "all" | "last-7-days";

export interface DatabaseState {
  search: string;
  sort: RecipeIndexSort;
  marked: MarkedFilter;
  scheduled: ScheduledFilter;
  added: AddedFilter;
  tags: string[];
}

interface CookingDatabaseProps {
  recipes: RecipeIndexItem[];
  totalCount: number;
  markedCount: number;
  availableTags: string[];
  state: DatabaseState;
  isPending?: boolean;
  sourceError?: string | null;
  onStateChange: (state: DatabaseState) => void;
  /** Publishes just the query text. Kept separate from `onStateChange` because the debounced
   * search settles on its own schedule: republishing a whole `DatabaseState` snapshot from that
   * timer would overwrite a sort or filter the user chose while the search was still settling. */
  onSearchChange: (search: string) => void;
  onOpenRecipe: (path: string, split: boolean) => void;
  onToggleMarked: (path: string, marked: boolean) => Promise<void>;
  onClearMarked: () => Promise<void>;
  resolveCover: (path: string | null, source: string) => string | null;
  onPointerDownRecipe?: (path: string, coverUrl?: string) => void;
}

const MIN_CARD_WIDTH_FLOOR = 160;
const DEFAULT_CARD_MIN_WIDTH = 220;
// Card covers stop at 2x density: 672 px serves a 323 px phone card at 2.1x, and a 3x
// photograph is not distinguishable from a 2x one at that pixel pitch (decision 2026-09-03).
// The 1288 px files stay for the recipe hero, which renders the full viewport width.
const SAMPLE_COVER_WIDTHS = [224, 672] as const;
const CARD_COVER_SIZES = [
  "(max-width: 516px) calc(100vw - 67px)",
  "(max-width: 720px) calc((100vw - 81px) / 2)",
  "(max-width: 796px) calc((100vw - 129px) / 2)",
  "(max-width: 1028px) calc((100vw - 143px) / 3)",
  "(max-width: 1260px) calc((100vw - 157px) / 4)",
  "(max-width: 1492px) calc((100vw - 171px) / 5)",
  "calc((100vw - 185px) / 6)",
].join(", ");

type ResponsiveSampleCover = { avifSrcSet: string; webpSrcSet: string };

function responsiveSampleCover(url: string): ResponsiveSampleCover | null {
  const match = /^(.*\/samples\/)([^/?#]+)\.webp([?#].*)?$/.exec(url);
  if (!match) return null;
  const [, directory, stem, suffix = ""] = match;
  const srcSet = (extension: "avif" | "webp") => SAMPLE_COVER_WIDTHS
    .map((width) => `${directory}${stem}-${width}.${extension}${suffix} ${width}w`)
    .join(", ");
  return { avifSrcSet: srcSet("avif"), webpSrcSet: srcSet("webp") };
}

function formatVisibleCount(recipes: RecipeIndexItem[], totalCount: number): string {
  if (recipes.length < totalCount) {
    return `${recipes.length} of ${totalCount} recipes`;
  }
  return `${totalCount} ${totalCount === 1 ? "recipe" : "recipes"}`;
}

function hasActiveQuery(state: DatabaseState): boolean {
	return Boolean(
		state.search.trim() ||
		state.tags.length > 0 ||
		state.marked !== "all" ||
		state.scheduled !== "all" ||
		state.added !== "all"
	);
}

/**
 * A tag being typed at the caret: `#` plus whatever follows it, anchored to the end of the
 * query. Anchoring to the tail is what keeps this a lookahead rather than a query parser --
 * there is no mid-string edit to reconcile -- and `#` cannot collide with recipe text because
 * no recipe title or vault path carries one.
 */
const TAG_DRAFT = /(?:^|\s)#([a-z0-9-]*)$/i;

const TAG_SUGGESTION_LIMIT = 8;

function matchTagDraft(query: string): string | null {
  const match = TAG_DRAFT.exec(query);
  return match ? match[1] : null;
}

/**
 * The query with any in-progress `#tag` removed. The grid searches on this rather than on the
 * raw field, so typing a tag narrows the collection by tag instead of emptying it against a
 * substring that no recipe contains.
 */
function stripTagDraft(query: string): string {
  return query.replace(TAG_DRAFT, "").trim();
}

const SORT_OPTIONS: ReadonlyArray<{ value: RecipeIndexSort; label: string }> = [
  { value: "added-desc", label: "Newest" },
  { value: "added-asc", label: "Oldest" },
  { value: "title-asc", label: "Title (A-Z)" },
  { value: "title-desc", label: "Title (Z-A)" },
  { value: "scheduled-desc", label: "Scheduled (latest)" },
  { value: "scheduled-asc", label: "Scheduled (oldest)" },
];

function sortLabel(sort: RecipeIndexSort): string {
  return SORT_OPTIONS.find((option) => option.value === sort)?.label ?? SORT_OPTIONS[0].label;
}

/** Filters folded behind the Filter button. Tags are excluded -- they are visible as chips. */
function countActiveFilters(state: DatabaseState): number {
  return (
    (state.marked === "all" ? 0 : 1) +
    (state.scheduled === "all" ? 0 : 1) +
    (state.added === "all" ? 0 : 1)
  );
}

export const CookingDatabase = React.memo(function CookingDatabase({
  recipes,
  totalCount,
  markedCount,
  availableTags,
  state,
  isPending = false,
  sourceError = null,
  onStateChange,
  onSearchChange,
  onOpenRecipe,
  onToggleMarked,
  onClearMarked,
  resolveCover,
  onPointerDownRecipe,
}: CookingDatabaseProps): React.JSX.Element {
  const [search, setSearch] = React.useState(state.search);
  const [showImport, setShowImport] = React.useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("share-target"));
  const [importPending, setImportPending] = React.useState(false);
  const [coverFile, setCoverFile] = React.useState<File | null>(null);
  const [importError, setImportError] = React.useState("");
  const [paste, setPaste] = React.useState<PasteRecipeInput>(() => {
    const shared = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
    return { title: shared?.get("title") ?? "", source: shared?.get("url") ?? "", ingredients: shared?.get("text") ?? "", method: "", prepTime: "", cookTime: "", servings: "" };
  });
  const renderedRecipes = recipes.map((recipe) => ({
    recipe, coverPath: resolveCover(recipe.coverPath, recipe.path)
  }));
  const initialCovers = renderedRecipes.slice(0, 6).filter(({ coverPath }) => Boolean(coverPath));
  const submitPasteImport = async (event: React.FormEvent) => {
    event.preventDefault();
    setImportPending(true);
    setImportError("");
    try {
      await importPastedRecipe({ ...paste, cover: coverFile });
      setShowImport(false);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImportPending(false);
    }
  };
  const updatePaste = (field: keyof PasteRecipeInput) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setPaste(current => ({ ...current, [field]: event.target.value }));

  const tagDraft = matchTagDraft(search);
  const effectiveSearch = React.useMemo(() => stripTagDraft(search), [search]);
  const deferredSearch = React.useDeferredValue(effectiveSearch);
  const [openMenu, setOpenMenu] = React.useState<"filter" | "sort" | null>(null);
  const [suggestDismissed, setSuggestDismissed] = React.useState(false);
  const [highlight, setHighlight] = React.useState(0);
  const [clearPending, setClearPending] = React.useState(false);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  const cardMinWidth = Math.max(MIN_CARD_WIDTH_FLOOR, DEFAULT_CARD_MIN_WIDTH);

  // Semantic mark for the database latency harness: the moment the current database view has
  // both recipe data and a settled (non-pending) render. The detail carries the exact ordered
  // first four recipe paths, the active query key (sort + filters + search), and the total so the
  // harness can bind elementtiming entries to the right view. The mark resets when the query
  // identity changes, so sorting or filtering produces a fresh semantic-ready timestamp.
  const semanticReadyMarkedRef = React.useRef<string | null>(null);
  const semanticReadyQueryKey = React.useMemo(() => {
    return JSON.stringify({
      sort: state.sort,
      marked: state.marked,
      scheduled: state.scheduled,
      added: state.added,
      tags: state.tags,
      search: state.search,
      total: totalCount
    });
  }, [state.sort, state.marked, state.scheduled, state.added, state.tags, state.search, totalCount]);
  React.useEffect(() => {
    if (semanticReadyMarkedRef.current === semanticReadyQueryKey) return;
    if (recipes.length > 0 && !isPending && !sourceError) {
      semanticReadyMarkedRef.current = semanticReadyQueryKey;
      if (typeof performance !== "undefined" && typeof performance.mark === "function") {
        performance.mark("mep:database:semantic-ready", {
          detail: {
            count: recipes.length,
            total: totalCount,
            sort: state.sort,
            firstFourPaths: recipes.slice(0, 4).map((recipe) => recipe.path),
            firstViewportPaths: recipes.slice(0, 10).map((recipe) => recipe.path),
            initialCoverPaths: initialCovers.map(({ recipe }) => recipe.path),
            firstCoverPath: initialCovers[0]?.recipe.path ?? null,
            firstCoverUrl: initialCovers[0]?.coverPath ?? null,
            viewGeneration: semanticReadyQueryKey,
            queryKey: semanticReadyQueryKey
          }
        });
      }
    }
  }, [recipes, isPending, sourceError, state.sort, semanticReadyQueryKey, totalCount]);

  const onSearchChangeEvent = useEffectEvent(onSearchChange);
  const selectedTags = React.useMemo(() => new Set(state.tags), [state.tags]);

  React.useEffect(() => {
    onSearchChangeEvent(deferredSearch);
  }, [deferredSearch]);

  const updateState = (updates: Partial<DatabaseState>) => {
    onStateChange({ ...state, ...updates });
  };

  const tagSuggestions = React.useMemo(() => {
    if (tagDraft === null || suggestDismissed) return [];
    const prefix = tagDraft.toLowerCase();
    return availableTags
      .filter((tag) => !selectedTags.has(tag) && tag.toLowerCase().startsWith(prefix))
      .slice(0, TAG_SUGGESTION_LIMIT);
  }, [tagDraft, suggestDismissed, availableTags, selectedTags]);

  React.useEffect(() => {
    setHighlight(0);
  }, [tagDraft]);

  const acceptTag = (tag: string) => {
    if (selectedTags.has(tag)) return;
    // The draft text and the tag list move in one publish: leaving the `#tag` in the search
    // string would publish a substring no recipe can match.
    const nextSearch = stripTagDraft(search);
    setSearch(nextSearch);
    setSuggestDismissed(false);
    onStateChange({ ...state, search: nextSearch, tags: [...state.tags, tag] });
    searchInputRef.current?.focus();
  };

  const removeTag = (tag: string) => {
    updateState({ tags: state.tags.filter((entry) => entry !== tag) });
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace" && search === "" && state.tags.length > 0) {
      removeTag(state.tags[state.tags.length - 1]);
      return;
    }
    if (event.key === "Escape" && tagSuggestions.length > 0) {
      event.preventDefault();
      setSuggestDismissed(true);
      return;
    }
    if (tagSuggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((index) => (index + 1) % tagSuggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((index) => (index - 1 + tagSuggestions.length) % tagSuggestions.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      acceptTag(tagSuggestions[Math.min(highlight, tagSuggestions.length - 1)]);
    }
  };

  const handleClearMarked = async () => {
    if (clearPending || markedCount === 0) return;
    const message = `Clear marked status from ${markedCount} recipe${
      markedCount === 1 ? "" : "s"
    }?`;
    if (!confirm(message)) return;
    setClearPending(true);
    try {
      await onClearMarked();
    } finally {
      setClearPending(false);
    }
  };

  React.useEffect(() => {
    if (openMenu === null) return;
    const onClick = (e: MouseEvent) => {
      if (!(e.target as Element).closest(".cooking-db__popover")) setOpenMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  React.useEffect(() => {
    if (tagSuggestions.length === 0) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as Element).closest(".cooking-db__searchbox")) {
        setSuggestDismissed(true);
      }
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [tagSuggestions.length]);

  const activeFilterCount = countActiveFilters(state);

  return (
    <div className="cooking-db">
      <div className="cooking-db__header">
        <h2>Recipe Database</h2>
        <div className="cooking-db__count">
          {sourceError ? "Unavailable" : formatVisibleCount(recipes, totalCount)}
        </div>

        <div className="cooking-db__searchbox">
          {state.tags.length > 0 && (
            <div className="cooking-db__chips">
              {state.tags.map((tag) => (
                <button
                  key={tag}
                  className="cooking-db__chip"
                  type="button"
                  aria-label={`Remove tag filter ${tag}`}
                  onClick={() => removeTag(tag)}
                >
                  #{tag}
                  <span aria-hidden="true">&#215;</span>
                </button>
              ))}
            </div>
          )}
          <input
            ref={searchInputRef}
            className="cooking-db__search"
            type="search"
            role="combobox"
            aria-label="Search recipes"
            aria-autocomplete="list"
            aria-expanded={tagSuggestions.length > 0}
            aria-controls="cooking-db-tag-suggest"
            placeholder="Search recipes, or # for a tag"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSuggestDismissed(false);
            }}
            onKeyDown={handleSearchKeyDown}
          />
          {tagSuggestions.length > 0 && (
            <div className="cooking-db__tag-suggest" id="cooking-db-tag-suggest" role="listbox">
              {tagSuggestions.map((tag, index) => (
                <button
                  key={tag}
                  className={`cooking-db__tag-suggestion${index === highlight ? " is-active" : ""}`}
                  type="button"
                  role="option"
                  aria-selected={index === highlight}
                  // Keeps the caret in the field so the list does not tear down before the click.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => acceptTag(tag)}
                >
                  #{tag}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="cooking-db__popover cooking-db__sort">
          <button
            className="cooking-db__select cooking-db__popover-toggle"
            type="button"
            aria-haspopup="true"
            aria-expanded={openMenu === "sort"}
            // Sort always has a value, so it is named rather than counted.
            aria-label={`Sort recipes (${sortLabel(state.sort)})`}
            onClick={() => setOpenMenu(openMenu === "sort" ? null : "sort")}
          >
            Sort
            <span className="cooking-db__popover-badge mod-value" aria-hidden="true">
              {sortLabel(state.sort)}
            </span>
          </button>
          {openMenu === "sort" && (
            <div
              className="cooking-db__popover-menu cooking-db__sort-menu"
              role="listbox"
              aria-label="Sort recipes"
            >
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={`cooking-db__filter-action cooking-db__sort-option${
                    state.sort === option.value ? " is-active" : ""
                  }`}
                  type="button"
                  role="option"
                  aria-selected={state.sort === option.value}
                  onClick={() => {
                    updateState({ sort: option.value });
                    setOpenMenu(null);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="cooking-db__popover cooking-db__filter">
          <button
            className="cooking-db__select cooking-db__popover-toggle"
            type="button"
            aria-haspopup="true"
            aria-expanded={openMenu === "filter"}
            // The badge is decorative; the count belongs in the name so it is announced as one
            // control rather than read out as a stray digit after the word.
            aria-label={activeFilterCount > 0 ? `Filter (${activeFilterCount} active)` : "Filter"}
            onClick={() => setOpenMenu(openMenu === "filter" ? null : "filter")}
          >
            Filter
            {activeFilterCount > 0 && (
              <span className="cooking-db__popover-badge" aria-hidden="true">
                {activeFilterCount}
              </span>
            )}
          </button>
          {openMenu === "filter" && (
            <div className="cooking-db__popover-menu cooking-db__filter-menu">
              <div className="cooking-db__filter-row">
                <span aria-hidden="true">Marked</span>
                <select
                  className="cooking-db__select"
                  aria-label="Marked filter"
                  value={state.marked}
                  onChange={(e) => updateState({ marked: e.target.value as MarkedFilter })}
                >
                  <option value="all">Any</option>
                  <option value="marked">Only marked</option>
                  <option value="unmarked">Only unmarked</option>
                </select>
              </div>

              <div className="cooking-db__filter-row">
                <span aria-hidden="true">Scheduled</span>
                <select
                  className="cooking-db__select"
                  aria-label="Scheduled filter"
                  value={state.scheduled}
                  onChange={(e) => updateState({ scheduled: e.target.value as ScheduledFilter })}
                >
                  <option value="all">Any</option>
                  <option value="scheduled">Only scheduled</option>
                  <option value="unscheduled">Only unscheduled</option>
                </select>
              </div>

              <div className="cooking-db__filter-row">
                <span aria-hidden="true">Date added</span>
                <select
                  className="cooking-db__select"
                  aria-label="Added date filter"
                  value={state.added}
                  onChange={(e) => updateState({ added: e.target.value as AddedFilter })}
                >
                  <option value="all">Any time</option>
                  <option value="last-7-days">Last 7 days</option>
                </select>
              </div>

              <div className="cooking-db__filter-divider" />

              <button
                className="cooking-db__filter-action"
                type="button"
                disabled={activeFilterCount === 0}
                onClick={() => updateState({ marked: "all", scheduled: "all", added: "all" })}
              >
                Clear all filters
              </button>

              <div className="cooking-db__filter-divider" />

              <button
                className="cooking-db__filter-action mod-warning"
                type="button"
                onClick={handleClearMarked}
                disabled={markedCount === 0 || clearPending}
              >
                {clearPending ? "Clearing..." : "Clear marked"}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="cooking-db__grid-container">
        {sourceError ? (
          <div className="cooking-db__error" role="alert">{sourceError}</div>
        ) : showImport || (recipes.length === 0 && !isPending && !hasActiveQuery(state)) ? (
          <div className="cooking-db__empty cooking-db__onboarding">
            <h2>No recipes yet</h2>
            <p>
              A recipe is any Markdown file in this folder with a <code>## Ingredients</code> heading.
              Your library stays readable in any text editor or Obsidian vault.
            </p>
            <p>Paste the title, ingredient lines, and method steps to import a recipe.</p>
            {!showImport ? (
              <button type="button" className="cooking-db__filter-action" onClick={() => setShowImport(true)}>Import recipe</button>
            ) : (
              <form className="cooking-db__paste-import" onSubmit={submitPasteImport}>
                <label>Title<input aria-label="Recipe title" value={paste.title} onChange={updatePaste("title")} required /></label>
                <label>Source URL (optional)<input aria-label="Recipe source URL" type="url" value={paste.source} onChange={updatePaste("source")} /></label>
                <label>Ingredients<textarea aria-label="Recipe ingredients" value={paste.ingredients} onChange={updatePaste("ingredients")} placeholder="One ingredient per line" required /></label>
                <label>Method<textarea aria-label="Recipe method" value={paste.method} onChange={updatePaste("method")} placeholder="Cook until tender." required /></label>
                <label>Cover image (optional)<input aria-label="Recipe cover image" type="file" accept="image/*" onChange={(event) => setCoverFile(event.currentTarget.files?.[0] ?? null)} /></label>
                {importError && <p role="alert">{importError}</p>}
                <button type="submit" className="cooking-db__filter-action" disabled={importPending}>{importPending ? "Importing…" : "Import recipe"}</button>
              </form>
            )}
          </div>
        ) : recipes.length === 0 && !isPending ? (
          <div className="cooking-db__empty cooking-db__no-results" role="status">
            <h2>No recipes match these filters</h2>
            <p>Try a different search or clear the active filters.</p>
            <button
              type="button"
              className="cooking-db__filter-action"
              onClick={() => {
                setSearch("");
                onStateChange({ ...state, search: "", marked: "all", scheduled: "all", added: "all", tags: [] });
              }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div
            className="cooking-db__grid"
            style={{ "--cooking-db-card-size": `${cardMinWidth}px` } as React.CSSProperties}
          >
            {renderedRecipes.map(({ recipe, coverPath }) => (
              <RecipeCard
                key={recipe.path}
                recipe={recipe}
                coverPath={coverPath}
                onOpenRecipe={onOpenRecipe}
                onPointerDownRecipe={onPointerDownRecipe}
                onToggleMarked={onToggleMarked}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

type RecipeCardProps = {
  recipe: RecipeIndexItem;
  coverPath: string | null;
  onOpenRecipe: (path: string, split: boolean) => void;
  onToggleMarked: (path: string, marked: boolean) => Promise<void>;
  onPointerDownRecipe?: (path: string, coverUrl?: string) => void;
};

const RecipeCard: React.FC<RecipeCardProps> = React.memo(({ recipe, coverPath, onOpenRecipe, onPointerDownRecipe, onToggleMarked }) => {
  const [toggleDisabled, setToggleDisabled] = React.useState(false);
  const [optimisticMarked, setOptimisticMarked] = React.useState(recipe.marked);

  React.useEffect(() => {
    setOptimisticMarked(recipe.marked);
  }, [recipe.marked]);

  const handleToggle = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.checked;
    setOptimisticMarked(newValue);
    setToggleDisabled(true);
    try {
      await onToggleMarked(recipe.path, newValue);
    } catch (err) {
      setOptimisticMarked(!newValue);
      console.error("Failed to toggle marked", err);
    } finally {
      setToggleDisabled(false);
    }
  };

  const responsiveCover = coverPath ? responsiveSampleCover(coverPath) : null;
  const coverImage = coverPath ? (
    <img
      {...({
        src: coverPath,
        alt: "",
        decoding: "async",
        srcSet: responsiveCover?.webpSrcSet,
        sizes: responsiveCover ? CARD_COVER_SIZES : undefined,
        elementtiming: recipe.path,
        "data-path": recipe.path,
      } as React.ImgHTMLAttributes<HTMLImageElement>)}
    />
  ) : null;

  return (
    <article
      className="cooking-db__card"
      data-path={recipe.path}
      data-has-cover={coverPath ? "true" : "false"}
    >
      <button
        type="button"
        className="cooking-db__card-open"
        aria-label={`Open recipe ${recipe.title}`}
        onPointerDown={() => onPointerDownRecipe?.(recipe.path, coverPath ?? undefined)}
        onClick={(e) => onOpenRecipe(recipe.path, e.ctrlKey || e.metaKey)}
      >
        <div className={`cooking-db__cover ${coverPath ? "" : "cooking-db__cover--empty"}`}>
          {responsiveCover ? (
            <picture style={{ display: "contents" }}>
              <source type="image/avif" srcSet={responsiveCover.avifSrcSet} sizes={CARD_COVER_SIZES} />
              {coverImage}
            </picture>
          ) : coverImage}
        </div>
        <div className="cooking-db__body">
          <div
            {...({
              className: "cooking-db__title",
              elementtiming: `mep:database-card-title:${recipe.path}`,
            } as React.HTMLAttributes<HTMLDivElement>)}
          >
            {recipe.title}
          </div>
          <div className="cooking-db__meta">
            {recipe.added ? `Added ${recipe.added}` : ""}
          </div>
        </div>
      </button>
      <div className="cooking-db__actions">
        <label className="cooking-db__toggle">
          <input
            type="checkbox"
            checked={optimisticMarked}
            onChange={handleToggle}
            disabled={toggleDisabled}
          />
          <span>Marked</span>
        </label>
      </div>
    </article>
  );
}, areRecipeCardsEqual);

function areRecipeCardsEqual(prev: RecipeCardProps, next: RecipeCardProps): boolean {
  return (
    prev.recipe.path === next.recipe.path &&
    prev.recipe.title === next.recipe.title &&
    prev.recipe.added === next.recipe.added &&
    prev.recipe.marked === next.recipe.marked &&
    prev.coverPath === next.coverPath &&
    prev.onOpenRecipe === next.onOpenRecipe &&
    prev.onPointerDownRecipe === next.onPointerDownRecipe &&
    prev.onToggleMarked === next.onToggleMarked
  );
}
