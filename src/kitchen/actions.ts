import {
  appendShoppingItem, buildShoppingMarkdown, parsePlan, recipePlanning, removeShoppingItem,
  serializePlan, shoppingPlainText, toggleShoppingItem, withRecipePlanning,
  type Recipe, type RecipePlanning,
} from "../core";
import { readText, updateText, writeText } from "../host-client/browser-storage";
import { getKitchenSnapshot } from "./store";

type ShoppingPlan = { items: { content: string; sources?: string[] }[] };

let checkGeneration = 0;
export async function updatePlanRecipe(recipe: Recipe, update: (value: RecipePlanning) => RecipePlanning): Promise<void> {
  await updateText("Plan.md", (text) => {
    const plan = parsePlan(text);
    return serializePlan(withRecipePlanning(plan, recipe.link, update(recipePlanning(plan, recipe.link))));
  });
}
export async function clearMarkedRecipes(): Promise<void> {
  await updateText("Plan.md", (text) => serializePlan({ ...parsePlan(text), marked: [] }));
}
function plannedRecipes(plan: ShoppingPlan, recipes: readonly Recipe[]): Recipe[] {
  const byTitle = new Map(recipes.map((recipe) => [recipe.title, recipe]));
  const grouped = new Map<string, string[]>();
  for (const item of plan.items) {
    const title = item.sources?.[0] ?? "Shopping";
    grouped.set(title, [...(grouped.get(title) ?? []), item.content]);
  }
  return [...grouped].map(([title, ingredients]) => byTitle.get(title) ?? ({
    path: `${title}.md`, title, ingredients, method: [], cover: null, source: null, added: null,
    tags: [], body: "", markdown: "", link: title,
  }));
}
export async function applyShoppingPlan(plan: ShoppingPlan): Promise<void> {
  const recipes = getKitchenSnapshot().recipes;
  await updateText("Shopping.md", (text) => buildShoppingMarkdown(text, plannedRecipes(plan, recipes), recipes));
}
export const addShoppingItem = (content: string): Promise<string> => updateText("Shopping.md", (text) => appendShoppingItem(text, content));
export const removeShopping = (itemText: string): Promise<string> => updateText("Shopping.md", (text) => removeShoppingItem(text, itemText));
export async function toggleShopping(itemText: string, itemId: string, checked: boolean): Promise<void> {
  await updateText("Shopping.md", (text) => toggleShoppingItem(text, itemText, checked));
  performance.mark("mep:shopping:check-settled", { detail: {
    generation: ++checkGeneration, itemId, checked,
    presentationIdentifier: `mep:shopping-check:${itemId}:${checked ? "checked" : "unchecked"}`,
  }});
}
export async function copyShoppingList(): Promise<void> {
  await navigator.clipboard.writeText(shoppingPlainText(await readText("Shopping.md")));
}
export const saveRecipe = (path: string, text: string): Promise<void> => writeText(path, text);
