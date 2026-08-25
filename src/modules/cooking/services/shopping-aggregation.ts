import {
  DEFAULT_LABEL,
  SHOPPING_IGNORE_LIST,
  abbreviateRecipeTitle,
  formatCountQuantity,
  formatMetricQuantity,
  labelForIngredient,
  normalizeNameForKey,
  normalizeIgnoreValue,
  parseIngredientLine,
  pluralize
} from "./ingredient-parsing";
import type { ParsedIngredient, ShoppingItem } from "./ingredient-parsing";

export type IngredientRecipeSource = {
  path: string;
  title: string;
  ingredients: string[];
};

type AggregatedItem = {
  displayName: string;
  quantity: number | null;
  unit: "g" | "ml" | "count" | null;
  countUnit: string | null;
  sources: Set<string>;
};

function createRecipeLabel(titles: string[]): string {
  const abbreviated = titles.flatMap((title) => {
    const value = abbreviateRecipeTitle(title);
    return value ? [value] : [];
  });
  if (abbreviated.length === 0) return "";
  return `[${abbreviated.join(", ")}]`;
}

function buildAggregateKey(parsed: ParsedIngredient): string {
  const keyName = normalizeNameForKey(parsed.displayName);
  if (parsed.quantity === null || parsed.unit === null) {
    return `${keyName}|none`;
  }
  if (parsed.unit === "count") {
    return `${keyName}|count:${parsed.countUnit ?? "count"}`;
  }
  return `${keyName}|${parsed.unit}`;
}

function pushAggregateSource(
  aggregated: Map<string, AggregatedItem>,
  key: string,
  recipeTitle: string
): void {
  const existing = aggregated.get(key);
  if (existing) {
    existing.sources.add(recipeTitle);
  }
}

function aggregateIngredients(
  recipes: IngredientRecipeSource[],
  ignoreList: string[] = SHOPPING_IGNORE_LIST
): AggregatedItem[] {
  const aggregated = new Map<string, AggregatedItem>();
  const ignoreSet = new Set(ignoreList.map(normalizeIgnoreValue));

  for (const recipe of recipes) {
    for (const line of recipe.ingredients) {
      const parsed = parseIngredientLine(line);
      if (!parsed) continue;

      if (ignoreSet.has(normalizeIgnoreValue(parsed.displayName))) {
        continue;
      }

      const key = buildAggregateKey(parsed);

      if (parsed.quantity === null || parsed.unit === null) {
        if (!aggregated.has(key)) {
          aggregated.set(key, {
            displayName: parsed.displayName,
            quantity: null,
            unit: null,
            countUnit: null,
            sources: new Set([recipe.title])
          });
        } else {
          pushAggregateSource(aggregated, key, recipe.title);
        }
        continue;
      }

      const existing = aggregated.get(key);
      if (existing) {
        existing.quantity = (existing.quantity ?? 0) + parsed.quantity;
        existing.sources.add(recipe.title);
      } else {
        aggregated.set(key, {
          displayName: parsed.displayName,
          quantity: parsed.quantity,
          unit: parsed.unit,
          countUnit: parsed.countUnit,
          sources: new Set([recipe.title])
        });
      }
    }
  }

  return Array.from(aggregated.values());
}

function formatEntryName(entry: AggregatedItem): string {
  if (entry.unit !== "count" || entry.countUnit) {
    return entry.displayName;
  }
  return pluralize(entry.displayName, entry.quantity ?? 0);
}

function formatEntryQuantity(entry: AggregatedItem): string {
  if (entry.unit === "count") {
    return formatCountQuantity(entry.quantity ?? 0, entry.countUnit);
  }
  return formatMetricQuantity(entry.quantity ?? 0, entry.unit);
}

function buildShoppingItemContent(
  entry: AggregatedItem,
  recipeLabel: string
): string {
  if (entry.quantity === null || entry.unit === null) {
    return recipeLabel ? `${entry.displayName} - ${recipeLabel}` : entry.displayName;
  }

  const formattedQty = formatEntryQuantity(entry);
  const name = formatEntryName(entry);
  const baseContent = `${name} - ${formattedQty}`.trim();
  return recipeLabel ? `${baseContent} - ${recipeLabel}` : baseContent;
}

function buildShoppingItemsFromAggregates(
  aggregated: AggregatedItem[],
  labels: string[]
): ShoppingItem[] {
  if (labels.length !== aggregated.length) {
    throw new Error("Label count mismatch for shopping items.");
  }

  const items: ShoppingItem[] = [];
  for (const [index, entry] of aggregated.entries()) {
    const label = labels[index] ?? DEFAULT_LABEL;
    const recipeList = Array.from(entry.sources);
    const recipeLabel = createRecipeLabel(recipeList);
    const content = buildShoppingItemContent(entry, recipeLabel);
    items.push({
      content,
      labels: [label],
      sources: Array.from(entry.sources)
    });
  }

  return items;
}

export function buildShoppingItems(recipes: IngredientRecipeSource[]): ShoppingItem[] {
  const aggregated = aggregateIngredients(recipes);
  const labels = aggregated.map((entry) => labelForIngredient(entry.displayName));
  return buildShoppingItemsFromAggregates(aggregated, labels);
}
