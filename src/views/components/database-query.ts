import type { Plan, Recipe } from "@/core";
import type { RecipeIndexItem, RecipeIndexQuery } from "@/modules/cooking/types";
import type { StandaloneSettings } from "@/standalone/settings";
import type { DatabaseState } from "./CookingDatabase";

const DATABASE_IMAGE_PRELOAD_LIMIT = 500;

export function initialDatabaseState(settings: StandaloneSettings): DatabaseState {
  return {
    search: "",
    sort: settings.databaseSort,
    marked: settings.databaseMarkedFilter,
    scheduled: settings.databaseScheduledFilter,
    added: "all",
    tags: [],
  };
}

function resolveMarkedFilter(marked: DatabaseState["marked"]): boolean | undefined {
  if (marked === "marked") return true;
  if (marked === "unmarked") return false;
  return undefined;
}

function resolveScheduledFilter(scheduled: DatabaseState["scheduled"]): boolean | undefined {
  if (scheduled === "scheduled") return true;
  if (scheduled === "unscheduled") return false;
  return undefined;
}

function resolveAddedAfter(added: DatabaseState["added"]): number | undefined {
  if (added !== "last-7-days") return undefined;
  const since = new Date();
  since.setDate(since.getDate() - 7);
  since.setHours(0, 0, 0, 0);
  return since.getTime();
}

export function databaseQuery(state: DatabaseState): RecipeIndexQuery {
  return {
    sortBy: state.sort,
    filter: {
      marked: resolveMarkedFilter(state.marked),
      scheduled: resolveScheduledFilter(state.scheduled),
      tags: state.tags.length > 0 ? state.tags : undefined,
      addedAfter: resolveAddedAfter(state.added),
    },
    search: state.search,
    limit: DATABASE_IMAGE_PRELOAD_LIMIT,
  };
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export type DatabaseView = {
  items: RecipeIndexItem[];
  total: number;
  availableTags: string[];
  markedCount: number;
};

export function buildDatabaseView(
  recipes: readonly Recipe[],
  plan: Plan,
  query: RecipeIndexQuery = {},
): DatabaseView {
  let items = recipes.map((recipe) => {
    const scheduledDates = [...plan.days]
      .filter(([, entries]) => entries.includes(recipe.link))
      .map(([date]) => date)
      .sort();
    return {
      path: recipe.path,
      title: recipe.title,
      coverPath: recipe.cover,
      marked: plan.marked.includes(recipe.link),
      added: recipe.added,
      scheduled: scheduledDates[0] ?? null,
      scheduledDates,
      addedTimestamp: timestamp(recipe.added),
      scheduledTimestamp: timestamp(scheduledDates[0] ?? null),
      tags: recipe.tags,
    };
  });
  const filter = query.filter ?? {};
  if (filter.marked !== undefined) items = items.filter((item) => item.marked === filter.marked);
  if (filter.scheduled !== undefined) items = items.filter((item) => (item.scheduled !== null) === filter.scheduled);
  if (filter.tags?.length) items = items.filter((item) => filter.tags!.every((tag) => item.tags.includes(tag)));
  if (filter.addedAfter !== undefined) items = items.filter((item) => (item.addedTimestamp ?? 0) >= filter.addedAfter!);
  const search = query.search?.trim().toLowerCase();
  if (search) items = items.filter((item) => `${item.title} ${item.path}`.toLowerCase().includes(search));
  const sort = query.sortBy ?? "added-desc";
  items.sort((left, right) => {
    if (sort === "title-asc") return left.title.localeCompare(right.title);
    if (sort === "title-desc") return right.title.localeCompare(left.title);
    if (sort === "added-asc") return (left.added ?? "").localeCompare(right.added ?? "");
    if (sort === "scheduled-asc") return (left.scheduled ?? "").localeCompare(right.scheduled ?? "");
    if (sort === "scheduled-desc") return (right.scheduled ?? "").localeCompare(left.scheduled ?? "");
    return (right.added ?? "").localeCompare(left.added ?? "");
  });
  const total = items.length;
  if (query.limit !== undefined) items = items.slice(0, query.limit);
  return {
    items,
    total,
    availableTags: [...new Set(recipes.flatMap((recipe) => recipe.tags))].sort(),
    markedCount: recipes.filter((recipe) => plan.marked.includes(recipe.link)).length,
  };
}

export function projectDatabaseView(recipes: readonly Recipe[], plan: Plan, query: RecipeIndexQuery): { view: DatabaseView; sourceError: string | null } {
  try { return { view: buildDatabaseView(recipes, plan, query), sourceError: null }; }
  catch (error) {
    return { view: { items: [], total: 0, availableTags: [], markedCount: 0 },
      sourceError: error instanceof Error ? error.message : String(error) };
  }
}
