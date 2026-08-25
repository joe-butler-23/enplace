import * as React from "react";
import { setIcon } from "@/platform";
import { RecipeIndexItem, RecipeIndexSort } from "../../modules/cooking/types";
import { CookingAssistantSettings } from "../../settings";
import type { ImageResourceState, ImageResourceStore } from "../utils/image-resources";

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

export type DatabaseCoverState = { status: "none" } | { status: "pending" } | ImageResourceState;

interface CookingDatabaseProps {
  recipes: RecipeIndexItem[];
  totalCount: number;
  markedCount: number;
  availableTags: string[];
  settings: CookingAssistantSettings;
  state: DatabaseState;
  isPending?: boolean;
  sourceError?: string | null;
  onStateChange: (state: DatabaseState) => void;
  onOpenRecipe: (path: string, split: boolean) => void;
  onToggleMarked: (path: string, marked: boolean) => Promise<void>;
  onClearMarked: () => Promise<void>;
  onOpenPlanner: () => void;
  resolveCover: (path: string | null, source: string) => string | null;
  getCoverState: (coverPath: string | null) => DatabaseCoverState;
  /** Cover image state lives in this store outside React; each card subscribes to just its own
   * key so it reveals the moment its own cover decodes, without re-rendering its siblings. */
  coverStore: ImageResourceStore;
}

const SEARCH_DEBOUNCE_MS = 120;
const MIN_CARD_WIDTH_FLOOR = 160;
const DEFAULT_CARD_MIN_WIDTH = 220;

function formatVisibleCount(recipes: RecipeIndexItem[], totalCount: number): string {
  if (recipes.length < totalCount) {
    return `${recipes.length} of ${totalCount} recipes`;
  }
  return `${totalCount} recipes`;
}

function formatTagSummary(tags: string[]): string {
  if (tags.length === 0) {
    return "all";
  }
  if (tags.length === 1) {
    return tags[0];
  }
  return `${tags.length} selected`;
}

/**
 * Publishes the grid's *resolved* column width as `--cooking-db-card-intrinsic` so the cards'
 * `content-visibility` placeholder estimates their real height.
 *
 * `--cooking-db-card-size` is only the grid's minimum track; `auto-fit` plus `1fr` makes real
 * columns wider, so sizing the placeholder from it under-reports every card that has not been
 * rendered yet and the scroll height shifts under the user as they scroll into fresh content.
 * The measurement gets its own property because `--cooking-db-card-size` also feeds
 * `grid-template-columns` -- writing layout output back into layout input would oscillate.
 */
function useCardIntrinsicSize(grid: HTMLDivElement | null, cardMinWidth: number): void {
  React.useEffect(() => {
    if (!grid || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      // Resolves to a used px track list; the first track is every column's width.
      const track = Number.parseFloat(getComputedStyle(grid).gridTemplateColumns);
      if (!Number.isFinite(track) || track <= 0) return;
      const next = `${Math.round(track)}px`;
      // Setting a custom property here recalculates styles for every card, so only ever write
      // when the value actually moved.
      if (next === grid.style.getPropertyValue("--cooking-db-card-intrinsic")) return;
      grid.style.setProperty("--cooking-db-card-intrinsic", next);
    };
    const observer = new ResizeObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    });
    observer.observe(grid);
    measure();
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
    // `cardMinWidth` changes the track sizing without resizing the grid, so it needs a re-measure.
  }, [grid, cardMinWidth]);
}

export const CookingDatabase = React.memo(function CookingDatabase({
  recipes,
  totalCount,
  markedCount,
  availableTags,
  settings,
  state,
  isPending = false,
  sourceError = null,
  onStateChange,
  onOpenRecipe,
  onToggleMarked,
  onClearMarked,
  onOpenPlanner,
  resolveCover,
  getCoverState,
  coverStore,
}: CookingDatabaseProps): React.JSX.Element {
  const [search, setSearch] = React.useState(state.search);
  const deferredSearch = React.useDeferredValue(search);
  const [tagMenuOpen, setTagMenuOpen] = React.useState(false);
  const [clearPending, setClearPending] = React.useState(false);
  const latestStateRef = React.useRef(state);
  const [gridEl, setGridEl] = React.useState<HTMLDivElement | null>(null);
  const cardMinWidth = Math.max(
    MIN_CARD_WIDTH_FLOOR,
    settings.databaseCardMinWidth || DEFAULT_CARD_MIN_WIDTH
  );
  useCardIntrinsicSize(gridEl, cardMinWidth);

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
            queryKey: semanticReadyQueryKey
          }
        });
      }
    }
  }, [recipes, isPending, sourceError, state.sort, semanticReadyQueryKey, totalCount]);

  const onStateChangeEvent = React.useEffectEvent(onStateChange);
  const selectedTags = React.useMemo(() => new Set(state.tags), [state.tags]);

  React.useEffect(() => {
    latestStateRef.current = state;
  }, [state]);

  // Sync local search if prop changes
  React.useEffect(() => {
    setSearch(state.search);
  }, [state.search]);

  // Debounce search update
  React.useEffect(() => {
    const timer = setTimeout(() => {
      const latestState = latestStateRef.current;
      if (deferredSearch !== latestState.search) {
        onStateChangeEvent({ ...latestState, search: deferredSearch });
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [deferredSearch]);

  const updateState = (updates: Partial<DatabaseState>) => {
    onStateChange({ ...state, ...updates });
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

  // Tag menu click outside
  React.useEffect(() => {
    if (!tagMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as Element).closest(".cooking-db__tag-filter")) {
        setTagMenuOpen(false);
      }
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [tagMenuOpen]);

  return (
    <div className="cooking-db">
      <div className="cooking-db__header">
        <h2>Recipe Database</h2>
        <div className="cooking-db__count">
          {sourceError ? "Unavailable" : formatVisibleCount(recipes, totalCount)}
        </div>
      </div>

      <div className="cooking-db__controls">
        <button
          className="cooking-db__icon-button"
          type="button"
          aria-label="Open Cooking Planner"
          onClick={onOpenPlanner}
          ref={(el) => { if (el) setIcon(el, "calendar-days"); }}
        />

        <input
          className="cooking-db__search"
          type="search"
          placeholder="Search recipes..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <select
          className="cooking-db__select"
          aria-label="Sort recipes"
          value={state.sort}
          onChange={(e) => updateState({ sort: e.target.value as RecipeIndexSort })}
        >
          <option value="added-desc">Added (newest)</option>
          <option value="added-asc">Added (oldest)</option>
          <option value="title-asc">Title (A-Z)</option>
          <option value="title-desc">Title (Z-A)</option>
          <option value="scheduled-desc">Scheduled (latest)</option>
          <option value="scheduled-asc">Scheduled (oldest)</option>
        </select>

        <div className="cooking-db__tag-filter">
          <button
            className="cooking-db__select cooking-db__tag-toggle"
            type="button"
            aria-haspopup="listbox"
            aria-expanded={tagMenuOpen}
            onClick={() => setTagMenuOpen(!tagMenuOpen)}
          >
            Tags: {formatTagSummary(state.tags)}
          </button>
          {tagMenuOpen && (
            <div className="cooking-db__tag-menu" role="listbox">
              <label className="cooking-db__tag-option">
                <input
                  type="checkbox"
                  aria-label="Show all tags"
                  checked={state.tags.length === 0}
                  onChange={() => updateState({ tags: [] })}
                />
                <span>All tags</span>
              </label>
              {availableTags.map((tag) => (
                <label key={tag} className="cooking-db__tag-option">
                  <input
                    type="checkbox"
                    aria-label={`Filter by tag ${tag}`}
                    checked={selectedTags.has(tag)}
                    onChange={(e) => {
                      const newTags = e.target.checked
                        ? [...state.tags, tag]
                        : state.tags.filter((t) => t !== tag);
                      updateState({ tags: newTags });
                    }}
                  />
                  <span>{tag}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <select
          className="cooking-db__select"
          aria-label="Marked filter"
          value={state.marked}
          onChange={(e) => updateState({ marked: e.target.value as MarkedFilter })}
        >
          <option value="all">All marked</option>
          <option value="marked">Marked only</option>
          <option value="unmarked">Unmarked only</option>
        </select>

        <button
          className="cooking-db__button mod-warning"
          type="button"
          onClick={handleClearMarked}
          disabled={markedCount === 0 || clearPending}
        >
          {clearPending ? "Clearing..." : "Clear marked"}
        </button>

        <select
          className="cooking-db__select"
          aria-label="Scheduled filter"
          value={state.scheduled}
          onChange={(e) =>
            updateState({ scheduled: e.target.value as ScheduledFilter })
          }
        >
          <option value="all">All scheduled</option>
          <option value="scheduled">Scheduled only</option>
          <option value="unscheduled">Unscheduled only</option>
        </select>

        <select
          className="cooking-db__select"
          aria-label="Added date filter"
          value={state.added}
          onChange={(e) => updateState({ added: e.target.value as AddedFilter })}
        >
          <option value="all">All added dates</option>
          <option value="last-7-days">Added in last 7 days</option>
        </select>
      </div>

      <div className="cooking-db__grid-container">
        {sourceError ? (
          <div className="cooking-db__error" role="alert">{sourceError}</div>
        ) : recipes.length === 0 && !isPending ? (
          <div className="cooking-db__empty cooking-db__onboarding">
            <h2>No recipes yet</h2>
            <p>
              A recipe is a plain Markdown file with <code>title</code>,{" "}
              <code>type: recipe</code>, and <code>source</code> frontmatter, stored in your
              vault&apos;s recipe folder. Your library stays readable in any text editor or
              Obsidian vault.
            </p>
            <p>
              To add your first recipe, ask your coding agent to use the bundled{" "}
              <code>recipe-extraction</code> skill, or import a Markdown file yourself with the{" "}
              <code>mep</code> CLI:
            </p>
            <pre><code>{`mep recipe import recipe.md --recipes-dir <vault>/cooking/recipes`}</code></pre>
            <p>
              Build the CLI from this repository with{" "}
              <code>cargo build --release -p mep-cli</code>; see{" "}
              <code>docs/mep-cli-contracts.md</code> for the full import contract.
            </p>
          </div>
        ) : (
          <div
            ref={setGridEl}
            className="cooking-db__grid"
            style={{ "--cooking-db-card-size": `${cardMinWidth}px` } as React.CSSProperties}
          >
            {recipes.map((recipe) => (
              <RecipeCard
                key={recipe.path}
                recipe={recipe}
                coverPath={resolveCover(recipe.coverPath, recipe.path)}
                getCoverState={getCoverState}
                coverStore={coverStore}
                onOpenRecipe={onOpenRecipe}
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
  getCoverState: (coverPath: string | null) => DatabaseCoverState;
  coverStore: ImageResourceStore;
  onOpenRecipe: (path: string, split: boolean) => void;
  onToggleMarked: (path: string, marked: boolean) => Promise<void>;
};

const RecipeCard: React.FC<RecipeCardProps> = React.memo(({ recipe, coverPath, getCoverState, coverStore, onOpenRecipe, onToggleMarked }) => {
  // Subscribes to just this card's own key: React's useSyncExternalStore only re-renders when
  // getSnapshot's *return value* changes, so a decode completing for any other card in the grid
  // never touches this one -- the cascade that a grid-level subscription would cause.
  const coverState = React.useSyncExternalStore(
    React.useCallback((onStoreChange: () => void) => coverStore.subscribe(onStoreChange), [coverStore]),
    React.useCallback(() => getCoverState(coverPath), [getCoverState, coverPath])
  );
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpenRecipe(recipe.path, e.ctrlKey || e.metaKey);
    }
  };

  return (
    <div
      className="cooking-db__card"
      role="button"
      aria-label={`Open recipe ${recipe.title}`}
      data-path={recipe.path}
      data-has-cover={coverState.status === "none" ? "false" : "true"}
      data-image-state={coverState.status}
      tabIndex={0}
      onClick={(e) => onOpenRecipe(recipe.path, e.ctrlKey || e.metaKey)}
      onKeyDown={handleKeyDown}
    >
      <div className={`cooking-db__cover ${coverState.status !== "ready" ? "cooking-db__cover--empty" : ""}`}>
        {coverState.status === "ready" && (
          // @ts-expect-error elementtiming is a valid Element Timing API attribute and is not
          // declared in React's bundled HTML type definitions.
          <img src={coverState.resource.url} alt={recipe.title} decoding="async" elementtiming={recipe.path} data-path={recipe.path} />
        )}
      </div>
      <div className="cooking-db__body">
        <div className="cooking-db__title">{recipe.title}</div>
        <div className="cooking-db__meta">
          {recipe.added ? `Added ${recipe.added}` : ""}
        </div>
        <div
          className="cooking-db__actions"
          onClick={(e) => e.stopPropagation()}
        >
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
      </div>
    </div>
  );
}, areRecipeCardsEqual);

function areRecipeCardsEqual(prev: RecipeCardProps, next: RecipeCardProps): boolean {
  return (
    prev.recipe.path === next.recipe.path &&
    prev.recipe.title === next.recipe.title &&
    prev.recipe.added === next.recipe.added &&
    prev.recipe.marked === next.recipe.marked &&
    prev.coverPath === next.coverPath &&
    prev.getCoverState === next.getCoverState &&
    prev.coverStore === next.coverStore &&
    prev.onOpenRecipe === next.onOpenRecipe &&
    prev.onToggleMarked === next.onToggleMarked
  );
}
