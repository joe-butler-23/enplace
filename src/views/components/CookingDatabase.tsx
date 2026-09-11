import * as React from "react";
import type { Plan, Recipe } from "@/core";
import { RecipeIndexItem, RecipeIndexSort } from "../../modules/cooking/types";
import type { StandaloneSettings } from "@/standalone/settings";
import { useDismiss } from "@/shared/use-dismiss";
import { databaseQuery, initialDatabaseState, projectDatabaseView } from "./database-query";
import { AddRecipeDialog } from "./AddRecipeDialog";
import { AddButton } from "./AddButton";
import { RecipeCard } from "./RecipeCard";

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
  recipes: readonly Recipe[];
  plan: Plan;
  settings: StandaloneSettings;
  onPreferencesChange: (updates: Partial<StandaloneSettings>) => void | Promise<void>;
  onOpenRecipe: (path: string, split: boolean) => void;
  onToggleMarked: (path: string, marked: boolean) => Promise<void>;
  onClearMarked: () => Promise<void>;
  resolveCover: (path: string | null, source: string) => string | null;
  onPointerDownRecipe?: (path: string) => void;
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

// A tag draft is only recognized at the query tail.
const TAG_DRAFT = /(?:^|\s)#([a-z0-9-]*)$/i;
const TAG_SUGGESTION_LIMIT = 8;

function matchTagDraft(query: string): string | null {
  const match = TAG_DRAFT.exec(query);
  return match ? match[1] : null;
}
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
  recipes: sourceRecipes,
  plan,
  settings,
  onPreferencesChange,
  onOpenRecipe,
  onToggleMarked,
  onClearMarked,
  resolveCover,
  onPointerDownRecipe,
}: CookingDatabaseProps): React.JSX.Element {
  const [state, setState] = React.useState<DatabaseState>(() => initialDatabaseState(settings));
  const [showImport, setShowImport] = React.useState(false);

  React.useEffect(() => setState((current) => (
    current.sort === settings.databaseSort && current.marked === settings.databaseMarkedFilter
    && current.scheduled === settings.databaseScheduledFilter ? current : { ...current,
      sort: settings.databaseSort, marked: settings.databaseMarkedFilter,
      scheduled: settings.databaseScheduledFilter }
  )), [settings.databaseMarkedFilter, settings.databaseScheduledFilter, settings.databaseSort]);

  const tagDraft = matchTagDraft(state.search);
  const effectiveSearch = React.useMemo(() => stripTagDraft(state.search), [state.search]);
  const { view: { items: recipes, total: totalCount, markedCount, availableTags }, sourceError } = React.useMemo(
    () => projectDatabaseView(sourceRecipes, plan, databaseQuery({ ...state, search: effectiveSearch })),
    [sourceRecipes, plan, state.sort, state.marked, state.scheduled, state.added, state.tags, effectiveSearch],
  );
  const renderedRecipes = recipes.map((recipe) => ({
    recipe, coverPath: resolveCover(recipe.coverPath, recipe.path)
  }));
  const [openMenu, setOpenMenu] = React.useState<"filter" | "sort" | null>(null);
  const [suggestDismissed, setSuggestDismissed] = React.useState(false);
  const [highlight, setHighlight] = React.useState(0);
  const [clearPending, setClearPending] = React.useState(false);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

  const selectedTags = React.useMemo(() => new Set(state.tags), [state.tags]);

  const updateState = (updates: Partial<DatabaseState>) => {
    const next = { ...state, ...updates }; setState(next);
    if (updates.sort || updates.marked || updates.scheduled) void onPreferencesChange({
      databaseSort: next.sort, databaseMarkedFilter: next.marked,
      databaseScheduledFilter: next.scheduled,
    });
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
    const nextSearch = stripTagDraft(state.search);
    setSuggestDismissed(false);
    updateState({ search: nextSearch, tags: [...state.tags, tag] });
    searchInputRef.current?.focus();
  };

  const removeTag = (tag: string) => {
    updateState({ tags: state.tags.filter((entry) => entry !== tag) });
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace" && state.search === "" && state.tags.length > 0) {
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

  useDismiss(openMenu !== null, (target) => Boolean(target.closest(".cooking-db__popover")), () => setOpenMenu(null));
  useDismiss(tagSuggestions.length > 0, (target) => Boolean(target.closest(".cooking-db__searchbox")),
    () => setSuggestDismissed(true));

  const activeFilterCount = countActiveFilters(state);

  let databaseContent: React.ReactNode = (
    <div className="cooking-db__grid">
      {renderedRecipes.map(({ recipe, coverPath }) => (
        <RecipeCard key={recipe.path} recipe={recipe} coverPath={coverPath}
          onOpenRecipe={onOpenRecipe} onPointerDownRecipe={onPointerDownRecipe}
          onToggleMarked={onToggleMarked} />
      ))}
    </div>
  );
  if (recipes.length === 0) {
    databaseContent = (
      <div className="cooking-db__empty" role="status">
        <h2>No recipes match these filters</h2>
        <p>Try a different search or clear the active filters.</p>
        <button type="button" className="mep-button"
          onClick={() => updateState({ search: "", marked: "all", scheduled: "all", added: "all", tags: [] })}>
          Clear filters
        </button>
      </div>
    );
  }
  if (recipes.length === 0 && !hasActiveQuery(state)) {
    databaseContent = (
      <div className="cooking-db__empty">
        <h2>No recipes yet</h2>
        <p>Import a web page, paste Markdown, or open a file to start your cookbook.</p>
      </div>
    );
  }
  if (sourceError) databaseContent = <div className="cooking-db__error" role="alert">{sourceError}</div>;

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
            value={state.search}
            onChange={(e) => {
              setState({ ...state, search: e.target.value });
              setSuggestDismissed(false);
            }}
            onKeyDown={handleSearchKeyDown}
          />
          {tagSuggestions.length > 0 && (
            <div className="mep-menu cooking-db__tag-suggest" id="cooking-db-tag-suggest" role="listbox">
              {tagSuggestions.map((tag, index) => (
                <button
                  key={tag}
                  className={`mep-menu__item${index === highlight ? " is-active" : ""}`}
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

        <div className="cooking-db__tools">
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
              className="mep-menu cooking-db__popover-menu"
              role="listbox"
              aria-label="Sort recipes"
            >
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={`mep-menu__item${state.sort === option.value ? " is-active" : ""}`}
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
            <div className="mep-menu cooking-db__popover-menu cooking-db__filter-menu">
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

              <div className="mep-menu__divider" />

              <button
                className="mep-menu__item"
                type="button"
                disabled={activeFilterCount === 0}
                onClick={() => updateState({ marked: "all", scheduled: "all", added: "all" })}
              >
                Clear all filters
              </button>

              <div className="mep-menu__divider" />

              <button
                className="mep-menu__item mod-warning"
                type="button"
                onClick={handleClearMarked}
                disabled={markedCount === 0 || clearPending}
              >
                {clearPending ? "Clearing…" : "Clear marked"}
              </button>
            </div>
          )}
        </div>
        </div>
      </div>

      <AddButton label="Add recipe" expanded={showImport} onClick={() => setShowImport(true)} />
      {showImport ? <AddRecipeDialog onClose={() => setShowImport(false)} /> : null}
      <div className="cooking-db__grid-container">
        {databaseContent}
      </div>
    </div>
  );
});
