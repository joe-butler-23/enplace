import { describe, expect, it } from "vitest";
import { scanRecipes } from "@/core";
import { BuiltInShoppingListService } from "./BuiltInShoppingListService";

function serviceWith(markdown: Map<string, string>) {
  const byPath = new Map(scanRecipes([...markdown].map(([path, text]) => ({ path, text })))
    .map((recipe) => [recipe.path, recipe]));
  return new BuiltInShoppingListService(async (path) => byPath.get(path) ?? null);
}

describe("BuiltInShoppingListService", () => {
  it("loads scheduled recipes in deterministic order and previews Markdown aggregation", async () => {
    const recipes = new Map([
      ["Recipes/b.md", "# B\n\n## Ingredients\n- onion\n\n## Method\n1. Cook"],
      ["Recipes/a.md", "# A\n\n## Ingredients\n- milk\n\n## Method\n1. Cook"],
    ]);

    const preview = await serviceWith(recipes).previewWeek({
      recipePaths: ["Recipes/b.md", "Recipes/a.md", "Recipes/b.md"],
      weekLabel: "This week",
    });

    expect(preview).toEqual({
      weekLabel: "This week",
      items: [
        { id: "desired:0", content: "milk", labels: [], sources: ["A"], checked: false },
        { id: "desired:1", content: "onion", labels: [], sources: ["B"], checked: false },
      ],
    });
  });

  it("fails closed and names every missing requested recipe", async () => {
    await expect(serviceWith(new Map()).previewWeek({
      recipePaths: ["Recipes/missing-b.md", "Recipes/missing-a.md", "Recipes/missing-b.md"],
      weekLabel: "This week",
    })).rejects.toThrow("Missing scheduled recipe files: Recipes/missing-a.md, Recipes/missing-b.md");
  });

  it("fails closed when only part of the requested week can be loaded", async () => {
    const recipes = new Map([["Recipes/present.md", "# Present\n\n## Ingredients\n- salt"]]);
    await expect(serviceWith(recipes).previewWeek({
      recipePaths: ["Recipes/present.md", "Recipes/missing.md"],
      weekLabel: "This week",
    })).rejects.toThrow("Missing scheduled recipe files: Recipes/missing.md");
  });
});
