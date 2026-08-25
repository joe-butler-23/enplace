import { App, TFile } from "@/platform";
import { CookingAssistantSettings } from "../../../settings";
import { RecipeIndexItem, RecipeIndexQuery } from "../types";
import { mepRecipeDatabaseView, RecipeDatabaseView } from "../../../pttNode";

export type { RecipeIndexSort, RecipeIndexFilter, RecipeIndexQuery, RecipeIndexItem } from "../types";

export class RecipeIndexService {
  private cache: { key: string; view: RecipeDatabaseView; timestamp: number } | null = null;
  private dirty = true;
  private readonly minRescanMs = 1500;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => CookingAssistantSettings
  ) {}

  markDirty() {
    this.dirty = true;
    this.cache = null;
  }

  private getVaultPath(): string | undefined {
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    if (typeof adapter.getBasePath === "function") {
      const basePath = adapter.getBasePath();
      return basePath || undefined;
    }
    return undefined;
  }

  private buildView(query: RecipeIndexQuery = {}): RecipeDatabaseView {
    const key = this.buildCacheKey(query);
    const now = Date.now();

    if (this.cache && this.cache.key === key) {
      if (!this.dirty) {
        return this.cache.view;
      }
      if (now - this.cache.timestamp < this.minRescanMs) {
        return this.cache.view;
      }
    }

    const view = mepRecipeDatabaseView(this.getVaultPath(), query);
    this.cache = { key, view, timestamp: now };
    this.dirty = false;
    return view;
  }

  private buildCacheKey(query: RecipeIndexQuery = {}): string {
    const filter = query.filter ?? {};
    const key = {
      search: query.search ?? "",
      sortBy: query.sortBy ?? "",
      recipesFolder: query.recipesFolder ?? "",
      limit: query.limit ?? null,
      filter: {
        marked: filter.marked ?? null,
        scheduled: filter.scheduled ?? null,
        addedAfter: filter.addedAfter ?? null,
        tags: filter.tags ? [...filter.tags].sort() : []
      }
    };
    return JSON.stringify(key);
  }

  getAvailableTags(): string[] {
    return this.buildView().availableTags;
  }

  getRecipes(query: RecipeIndexQuery = {}): RecipeIndexItem[] {
    return this.queryRecipes(query).items;
  }

  queryRecipes(
    query: RecipeIndexQuery = {}
  ): { items: RecipeIndexItem[]; total: number; availableTags: string[]; markedCount: number } {
    const settings = this.getSettings();
    const limit = query.limit ?? settings.databaseMaxCards;
    const view = this.buildView({ ...query, recipesFolder: settings.recipesFolder, limit });
    return {
      items: view.items,
      total: view.total,
      availableTags: view.availableTags,
      markedCount: view.markedCount
    };
  }

  getMarkedCount(): number {
    return this.buildView().markedCount;
  }

  async setMarked(path: string, value: boolean) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      throw new Error(`Recipe not found: ${path}`);
    }

    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      if (value) {
        frontmatter.marked = true;
      } else {
        delete frontmatter.marked;
      }
    });
  }

  async clearAllMarked() {
    const settings = this.getSettings();
    const markedItems = this.buildView({
      recipesFolder: settings.recipesFolder,
      filter: { marked: true },
      limit: undefined
    }).items;
    for (let index = 0; index < markedItems.length; index += 8) {
      await Promise.all(
        markedItems.slice(index, index + 8).map((item) => this.setMarked(item.path, false))
      );
    }
  }
}
