import { App, TFile, normalizePath } from "@/platform";
import {
  mepShoppingPreview,
  type CookingRecipeInput,
  type ShoppingListPlan
} from "@/host-client/commands";

type ShoppingPreviewClient = {
  preview(args: {
    weekLabel: string;
    desiredItems: Array<{ content: string; labels: string[] }>;
  }): Promise<ShoppingListPlan>;
};

export class BuiltInShoppingListService {
  constructor(
    private readonly app: App,
    private readonly api: ShoppingPreviewClient = { preview: mepShoppingPreview }
  ) {}

  async previewWeek(payload: {
    recipePaths: string[];
    weekLabel: string;
  }): Promise<ShoppingListPlan> {
    const recipes = (
      await Promise.all(
        [...new Set(payload.recipePaths)].sort().map((path) => this.loadRecipe(path))
      )
    ).filter((recipe): recipe is CookingRecipeInput => recipe !== null);
    if (recipes.length === 0) {
      throw new Error("No scheduled recipes found for this week.");
    }
    const desiredItems = await this.app.cookingCapabilities.buildDesiredItems(recipes);
    return this.api.preview({ weekLabel: payload.weekLabel, desiredItems });
  }

  private async loadRecipe(recipePath: string): Promise<CookingRecipeInput | null> {
    const file = this.app.vault.getAbstractFileByPath(recipePath);
    if (!(file instanceof TFile)) return null;
    const machinePath = this.machineSidecarPath(file);
    const machineFile = this.app.vault.getAbstractFileByPath(machinePath);
    const [markdown, machineSidecarJson] = await Promise.all([
      this.app.vault.read(file),
      machineFile instanceof TFile ? this.app.vault.read(machineFile) : Promise.resolve(null)
    ]);
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    return {
      path: recipePath,
      title: (frontmatter.title as string) || file.basename || recipePath,
      markdown,
      machineSidecarJson
    };
  }

  private machineSidecarPath(file: TFile): string {
    const recipePath = normalizePath(file.path);
    const slash = recipePath.lastIndexOf("/");
    const parent = slash >= 0 ? recipePath.slice(0, slash) : "";
    return normalizePath(
      parent
        ? `${parent}/.machine/${file.basename}.json`
        : `.machine/${file.basename}.json`
    );
  }
}
