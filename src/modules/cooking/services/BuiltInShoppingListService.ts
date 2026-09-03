import type { Recipe } from "@/core";
import type { ShoppingListPlan } from "@/views/components/ShoppingListView";

export class BuiltInShoppingListService {
  constructor(private readonly loadRecipe: (path: string) => Promise<Recipe | null>) {}

  async previewWeek(payload: { recipePaths: string[]; weekLabel: string }): Promise<ShoppingListPlan> {
    const requestedPaths = [...new Set(payload.recipePaths)].sort();
    const loaded = await Promise.all(requestedPaths.map(async (path) => ({
      path,
      recipe: await this.loadRecipe(path),
    })));
    const missing = loaded.filter(({ recipe }) => recipe === null).map(({ path }) => path);
    if (missing.length > 0) throw new Error(`Missing scheduled recipe files: ${missing.join(", ")}`);
    const seen = new Set<string>();
    const items = loaded.flatMap(({ recipe }) => recipe!.ingredients.flatMap((content) => {
      const key = content.trim().toLocaleLowerCase();
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ content, labels: [], sources: [recipe!.title] }];
    })).map((item, index) => ({ ...item, id: `desired:${index}`, checked: false }));
    return { weekLabel: payload.weekLabel, items };
  }
}
