import { describe, expect, it, vi } from "vitest";
import { TFile } from "@/platform";
import { BuiltInShoppingListService } from "./BuiltInShoppingListService";

describe("BuiltInShoppingListService", () => {
  it("loads scheduled recipes in deterministic order and previews Rust aggregation", async () => {
    const recipes = new Map([
      ["Recipes/b.md", "# B\n\n## Ingredients\n- 1 | onion | produce\n\n## Method\n1. Cook"],
      ["Recipes/a.md", "# A\n\n## Ingredients\n- 1 | milk | dairy\n\n## Method\n1. Cook"]
    ]);
    const buildDesiredItems = vi.fn().mockResolvedValue([
      { content: "milk - 1 (A)", labels: ["dairy"] },
      { content: "onion - 1 (B)", labels: ["produce"] }
    ]);
    const app = {
      vault: {
        getAbstractFileByPath: (path: string) =>
          recipes.has(path)
            ? new TFile(path, path.split("/").at(-1) ?? path, path, { mtime: 0, size: 0 })
            : null,
        read: async (file: TFile) => recipes.get(file.path) ?? ""
      },
      metadataCache: { getFileCache: () => null },
      cookingCapabilities: { buildDesiredItems }
    };
    const preview = vi.fn().mockResolvedValue({ baseRevision: 0, items: [] });

    await new BuiltInShoppingListService(app as never, { preview } as never).previewWeek({
      recipePaths: ["Recipes/b.md", "Recipes/a.md", "Recipes/b.md"],
      weekLabel: "This week"
    });

    expect(buildDesiredItems.mock.calls[0][0].map((recipe: { path: string }) => recipe.path)).toEqual([
      "Recipes/a.md",
      "Recipes/b.md"
    ]);
    expect(preview).toHaveBeenCalledWith({
      weekLabel: "This week",
      desiredItems: [
        { content: "milk - 1 (A)", labels: ["dairy"] },
        { content: "onion - 1 (B)", labels: ["produce"] }
      ]
    });
  });
});
