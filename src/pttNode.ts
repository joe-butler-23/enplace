import type { App, TFile } from "@/platform";
import type { RecipeIndexSort } from "@/modules/cooking/types";
import {
  compareRecipeDatabaseItems,
  recipeSearchIndex,
  normalizeRecipeSearchText
} from "@/modules/cooking/utils/recipe-order";

export type RecipeDatabaseQuery = {
  search?: string;
  sortBy?: RecipeIndexSort;
  recipesFolder?: string;
  filter?: {
    marked?: boolean;
    scheduled?: boolean;
    tags?: string[];
    addedAfter?: number;
  };
  limit?: number;
};

export type RecipeDatabaseItem = {
  path: string;
  title: string;
  coverPath: string | null;
  marked: boolean;
  added: string | null;
  scheduled: string | null;
  scheduledDates?: string[];
  addedTimestamp: number | null;
  scheduledTimestamp: number | null;
  tags: string[];
};

export type RecipeDatabaseView = {
  items: RecipeDatabaseItem[];
  total: number;
  availableTags: string[];
  markedCount: number;
};

function parseTagsFromFrontmatter(tags: unknown): string[] {
  if (Array.isArray(tags)) {
    return tags.filter((tag) => typeof tag === "string") as string[];
  }
  if (typeof tags === "string") {
    return tags
      .split(/[,\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return [];
}

function getString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function getStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    const values = value
      .map((entry) => getString(entry))
      .filter((entry): entry is string => Boolean(entry));
    return Array.from(new Set(values));
  }
  const single = getString(value);
  return single ? [single] : [];
}

function toTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function sortRecipes(items: RecipeDatabaseView["items"], sortBy: string): RecipeDatabaseView["items"] {
  const sorted = [...items];
  sorted.sort((left, right) => compareRecipeDatabaseItems(left, right, sortBy));
  return sorted;
}

export function buildRecipeDatabaseView(
  app: App,
  options: RecipeDatabaseQuery = {}
): RecipeDatabaseView {
  const items: RecipeDatabaseView["items"] = [];
  const files = app.vault.getMarkdownFiles();
  const recipesFolder = options.recipesFolder?.replace(/\\/g, "/").replace(/\/+$/, "");

  for (const file of files) {
    if (recipesFolder && file.path !== recipesFolder && !file.path.startsWith(`${recipesFolder}/`)) {
      continue;
    }
    const cache = app.metadataCache.getFileCache(file as TFile);
    const frontmatter = cache?.frontmatter ?? {};
    const rawType = String(frontmatter.type ?? "").trim().toLowerCase();
    const isQuickMeal = frontmatter.quickMeal === true ||
      String(frontmatter.quickMeal ?? "").trim().toLowerCase() === "true";
    const isRecipeLike = rawType === "recipe" || (rawType === "reminder" && isQuickMeal);
    if (rawType && !isRecipeLike) {
      continue;
    }
    const title = getString(frontmatter.title) ?? file.basename;
    const coverPath = getString(frontmatter.cover);
    const marked = Boolean(frontmatter.marked);
    const scheduledDates = getStringList(frontmatter.scheduledDates);
    if (scheduledDates.length === 0) {
      scheduledDates.push(...getStringList(frontmatter.scheduled));
    }
    if (scheduledDates.length === 0) {
      const fallbackDate = getString(frontmatter.date ?? null);
      if (fallbackDate) {
        scheduledDates.push(fallbackDate);
      }
    }
    const scheduled = scheduledDates[0] ?? null;
    const added = getString(frontmatter.added);
    const tags = parseTagsFromFrontmatter(frontmatter.tags);

    items.push({
      path: file.path,
      title,
      coverPath,
      marked,
      added,
      scheduled,
      scheduledDates,
      addedTimestamp: toTimestamp(added),
      scheduledTimestamp: toTimestamp(scheduled),
      tags
    });
  }

  const filter = options.filter ?? {};
  let filtered = items;
  if (typeof filter.marked === "boolean") {
    filtered = filtered.filter((item) => item.marked === filter.marked);
  }
  if (typeof filter.scheduled === "boolean") {
    filtered = filtered.filter((item) => ((item.scheduledDates?.length ?? 0) > 0) === filter.scheduled);
  }
  if (filter.addedAfter) {
    filtered = filtered.filter((item) => (item.addedTimestamp ?? 0) >= filter.addedAfter!);
  }
  if (filter.tags && filter.tags.length > 0) {
    filtered = filtered.filter((item) => {
      const itemTags = new Set(item.tags);
      return filter.tags!.every((tag) => itemTags.has(tag));
    });
  }

    const search = normalizeRecipeSearchText(options.search ?? "");
    if (search) {
    // This is substring search, not repeated membership testing against a fixed collection.
    // react-doctor-disable-next-line js-set-map-lookups
    filtered = filtered.filter((item) => recipeSearchIndex(item).includes(search));
    }

  const availableTags = Array.from(new Set(items.flatMap((item) => item.tags))).sort();
  const markedCount = items.filter((item) => item.marked).length;
  const sorted = sortRecipes(filtered, options.sortBy ?? "added-desc");
  const limited = options.limit ? sorted.slice(0, options.limit) : sorted;

  return {
    items: limited,
    total: filtered.length,
    availableTags,
    markedCount
  };
}

export function installPttFallback(app: App): void {
  (globalThis as { __PTT_NODE__?: unknown }).__PTT_NODE__ = {
    mepRecipeDatabaseView: (_vaultPath?: string, options?: RecipeDatabaseQuery) =>
      buildRecipeDatabaseView(app, options),
  };
}

type PttNodeApi = {
  mepRecipeDatabaseView: (
    vaultPath?: string,
    options?: RecipeDatabaseQuery
  ) => RecipeDatabaseView;
};

function getPttNodeApi(): PttNodeApi | null {
  const injected = (globalThis as { __PTT_NODE__?: PttNodeApi }).__PTT_NODE__;
  return injected ?? null;
}

export function mepRecipeDatabaseView(
  vaultPath: string | undefined,
  options: RecipeDatabaseQuery
): RecipeDatabaseView {
  const api = getPttNodeApi();
  if (!api) {
    throw new Error("PTT runtime is not installed");
  }
  return api.mepRecipeDatabaseView(vaultPath, options);
}
