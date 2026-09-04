import {
  appendShoppingItem, buildShoppingMarkdown, parsePlan, recipePlanning, removeShoppingItem,
  serializePlan, shoppingPlainText, toggleShoppingItem, withRecipePlanning,
  type Recipe, type RecipePlanning,
} from "../core";
import { readText, remove, updateText } from "../host-client/browser-storage";
import { mergeText, type MergeResult } from "./merge";
import { getCookbookSnapshot } from "./store";

export async function updatePlanRecipe(recipe: Recipe, update: (value: RecipePlanning) => RecipePlanning): Promise<void> {
  await updateText("Plan.md", (text) => {
    const plan = parsePlan(text);
    return serializePlan(withRecipePlanning(plan, recipe.link, update(recipePlanning(plan, recipe.link))));
  });
}
export async function clearMarkedRecipes(): Promise<void> {
  await updateText("Plan.md", (text) => serializePlan({ ...parsePlan(text), marked: [] }));
}
function plannedShoppingRecipes(recipePaths: readonly string[], recipes: readonly Recipe[]): Recipe[] {
  const byPath = new Map(recipes.map((recipe) => [recipe.path, recipe]));
  const requestedPaths = [...new Set(recipePaths)].sort();
  const missing = requestedPaths.filter((path) => !byPath.has(path));
  if (missing.length) throw new Error(`Missing scheduled recipe files: ${missing.join(", ")}`);
  return requestedPaths.map((path) => byPath.get(path)!);
}
export async function applyShoppingPlan(recipePaths: readonly string[]): Promise<void> {
  const recipes = getCookbookSnapshot().recipes;
  const plannedRecipes = plannedShoppingRecipes(recipePaths, recipes);
  await updateText("Shopping.md", (text) => buildShoppingMarkdown(text, plannedRecipes, recipes));
}
export const addShoppingItem = (content: string): Promise<string> => updateText("Shopping.md", (text) => appendShoppingItem(text, content));
const shoppingLine = (itemId: string): number => {
  const match = /^line:(\d+)$/.exec(itemId);
  if (!match) throw new Error("Shopping item no longer exists");
  return Number(match[1]);
};
export const removeShopping = (itemText: string, itemId: string): Promise<string> => updateText(
  "Shopping.md", (text) => removeShoppingItem(text, shoppingLine(itemId), itemText),
);
export async function toggleShopping(itemText: string, itemId: string, checked: boolean): Promise<void> {
  await updateText("Shopping.md", (text) => toggleShoppingItem(text, shoppingLine(itemId), itemText, checked));
}
export async function copyShoppingList(): Promise<void> {
  await navigator.clipboard.writeText(shoppingPlainText(await readText("Shopping.md")));
}
export async function saveRecipe(path: string, base: string, draft: string): Promise<MergeResult> {
  let merged: MergeResult | null = null;
  await updateText(path, (current) => {
    merged = mergeText(base, draft, current);
    return merged.text;
  });
  if (!merged) throw new Error("Recipe update did not run.");
  return merged;
}
export const deleteRecipe = (path: string): Promise<void> => remove(path);
