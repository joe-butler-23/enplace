import type { RecipeDatabaseItem, RecipeDatabaseQuery, RecipeDatabaseView } from "../../../pttNode";
import {
  compareRecipeDatabaseItems,
  normalizeRecipeSearchText,
  recipeSearchIndex
} from "./recipe-order";

function parseQuery(key: string): RecipeDatabaseQuery | null {
  try {
    const value = JSON.parse(key) as RecipeDatabaseQuery;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function matchesQuery(item: RecipeDatabaseItem, query: RecipeDatabaseQuery): boolean {
  const filter = query.filter ?? {};
  if (typeof filter.marked === "boolean" && item.marked !== filter.marked) return false;
  if (typeof filter.scheduled === "boolean" && ((item.scheduledDates?.length ?? 0) > 0) !== filter.scheduled) {
    return false;
  }
  if (filter.addedAfter && (item.addedTimestamp ?? 0) < filter.addedAfter) return false;
  if (filter.tags?.length) {
    const itemTags = new Set(item.tags);
    if (!filter.tags.every((tag) => itemTags.has(tag))) return false;
  }
  const search = normalizeRecipeSearchText(query.search ?? "");
  return !search || recipeSearchIndex(item).includes(search);
}

/**
 * Projects a successful mark mutation into every materialized database query.
 * Views only contain the bounded result set, so the path is learned from any
 * cache that currently contains it and then inserted/re-sorted where the new
 * membership makes it visible in another cached query.
 */
export function projectMarkedInDatabaseViews(
  cache: Map<string, RecipeDatabaseView>,
  path: string,
  marked: boolean
): void {
  const known = new Map<string, RecipeDatabaseItem>();
  for (const view of cache.values()) {
    for (const item of view.items) {
      if (!known.has(item.path)) known.set(item.path, item);
    }
  }
  const current = known.get(path);
  if (!current || current.marked === marked) return;
  const nextItem = { ...current, marked };

  for (const [key, view] of cache.entries()) {
    const query = parseQuery(key);
    if (!query) continue;
    const beforeMatches = matchesQuery(current, query);
    const afterMatches = matchesQuery(nextItem, query);
    const items = view.items.filter((item) => item.path !== path);
    if (afterMatches) items.push(nextItem);
    items.sort((left, right) => compareRecipeDatabaseItems(left, right, query.sortBy ?? "added-desc"));
    const limit = query.limit && query.limit > 0 ? query.limit : undefined;
    if (limit !== undefined) items.splice(limit);
    cache.set(key, {
      ...view,
      items,
      total: Math.max(0, view.total + (afterMatches ? 1 : 0) - (beforeMatches ? 1 : 0)),
      markedCount: Math.max(0, view.markedCount + (marked ? 1 : -1))
    });
  }
}
