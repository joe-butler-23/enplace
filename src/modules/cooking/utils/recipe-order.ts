import type { RecipeDatabaseItem } from "../../../pttNode";
import type { RecipeIndexSort } from "../types";

/**
 * The database order contract uses locale-neutral Unicode lowercasing so the
 * Rust and web implementations produce the same order on every platform. Empty values are
 * sorted after dated values, for both ascending and descending date sorts.
 */
export function normalizeRecipeSortText(value: string): string {
  return value.trim().toLowerCase();
}

export function canonicalRecipePath(path: string): string {
  return normalizeRecipeSortText(path.replace(/\\/g, "/").replace(/^\/+/, ""));
}

function compareStrings(left: string, right: string): number {
  const leftChars = Array.from(left);
  const rightChars = Array.from(right);
  const length = Math.min(leftChars.length, rightChars.length);
  for (let index = 0; index < length; index += 1) {
    if (leftChars[index]! < rightChars[index]!) return -1;
    if (leftChars[index]! > rightChars[index]!) return 1;
  }
  if (leftChars.length < rightChars.length) return -1;
  if (leftChars.length > rightChars.length) return 1;
  return 0;
}

function compareOptionalTimestamps(
  left: number | null,
  right: number | null,
  descending: boolean
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const result = left < right ? -1 : left > right ? 1 : 0;
  return descending ? -result : result;
}

export function compareRecipeDatabaseItems(
  left: RecipeDatabaseItem,
  right: RecipeDatabaseItem,
  sort: RecipeIndexSort | string
): number {
  const leftTitle = normalizeRecipeSortText(left.title);
  const rightTitle = normalizeRecipeSortText(right.title);
  let primary = 0;
  switch (sort) {
    case "title-asc":
      primary = compareStrings(leftTitle, rightTitle);
      break;
    case "title-desc":
      primary = compareStrings(rightTitle, leftTitle);
      break;
    case "scheduled-asc":
      primary = compareOptionalTimestamps(left.scheduledTimestamp, right.scheduledTimestamp, false);
      break;
    case "scheduled-desc":
      primary = compareOptionalTimestamps(left.scheduledTimestamp, right.scheduledTimestamp, true);
      break;
    case "added-asc":
      primary = compareOptionalTimestamps(left.addedTimestamp, right.addedTimestamp, false);
      break;
    case "added-desc":
      primary = compareOptionalTimestamps(left.addedTimestamp, right.addedTimestamp, true);
      break;
    default:
      break;
  }
  if (primary !== 0) return primary;
  const title = compareStrings(leftTitle, rightTitle);
  if (title !== 0) return title;
  const path = compareStrings(canonicalRecipePath(left.path), canonicalRecipePath(right.path));
  if (path !== 0) return path;
  return compareStrings(left.path.replace(/\\/g, "/"), right.path.replace(/\\/g, "/"));
}

export function normalizeRecipeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function recipeSearchIndex(item: Pick<RecipeDatabaseItem, "title" | "path">): string {
  return `${normalizeRecipeSearchText(item.title)}\n${normalizeRecipeSearchText(item.path)}`;
}
