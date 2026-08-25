import { describe, expect, it, vi, beforeEach } from "vitest";
import { TFile } from "@/platform";
import type { App } from "@/platform";
import { RecipeIndexService } from "./RecipeIndexService";

const makeFile = (path: string) => {
  const name = path.split("/").pop() ?? path;
  const extension = name.includes(".") ? name.split(".").pop() ?? "" : "";
  return new TFile(path, name, extension, { mtime: 0, size: 0 });
};

const makeApp = (
  frontmatterMap: Map<string, any>,
  files: TFile[] = []
) => {
  return {
    vault: {
      adapter: {
        getBasePath: () => "/vault"
      },
      getAbstractFileByPath: (path: string) =>
        files.find((file) => file.path === path) ?? null
    },
    fileManager: {
      processFrontMatter: async (file: TFile, callback: (fm: any) => void) => {
        const frontmatter = { ...(frontmatterMap.get(file.path) ?? {}) };
        callback(frontmatter);
        frontmatterMap.set(file.path, frontmatter);
      }
    }
  } as unknown as App;
};

const settings = {
  recipesFolder: "recipes",
  imagesFolder: "recipes/images",
  databaseSort: "added-desc",
  databaseMarkedFilter: "all",
  databaseScheduledFilter: "all",
  databaseCardMinWidth: 220,
  databaseMaxCards: 500
};

let mepRecipeDatabaseView: ReturnType<typeof vi.fn>;

describe("RecipeIndexService", () => {
  beforeEach(() => {
    mepRecipeDatabaseView = vi.fn();
    (globalThis as { __PTT_NODE__?: unknown }).__PTT_NODE__ = {
      mepRecipeDatabaseView
    };
  });

  it("passes query options to ptt-core recipe view", () => {
    const view = {
      items: [
        {
          path: "recipes/alpha.md",
          title: "Alpha",
          coverPath: "recipes/images/alpha.webp",
          marked: true,
          added: "2026-01-01",
          scheduled: null,
          addedTimestamp: 0,
          scheduledTimestamp: null,
          tags: ["soup"]
        },
        {
          path: "recipes/beta.md",
          title: "Beta",
          coverPath: null,
          marked: false,
          added: null,
          scheduled: null,
          addedTimestamp: null,
          scheduledTimestamp: null,
          tags: []
        }
      ],
      total: 2,
      availableTags: ["soup"],
      markedCount: 1
    };
    mepRecipeDatabaseView.mockReturnValue(view);

    const app = makeApp(new Map());
    const service = new RecipeIndexService(app, () => settings);

    const result = service.queryRecipes({ sortBy: "title-asc" });

    expect(mepRecipeDatabaseView).toHaveBeenCalledWith("/vault", {
      sortBy: "title-asc",
      recipesFolder: settings.recipesFolder,
      limit: settings.databaseMaxCards
    });
    expect(result.items).toEqual(view.items);
    expect(result.availableTags).toEqual(view.availableTags);
    expect(result.markedCount).toBe(view.markedCount);
  });

  it("forwards filter and search values", () => {
    const view = {
      items: [],
      total: 0,
      availableTags: [],
      markedCount: 0
    };
    mepRecipeDatabaseView.mockReturnValue(view);

    const app = makeApp(new Map());
    const service = new RecipeIndexService(app, () => settings);

    service.queryRecipes({
      search: "salad",
      filter: { marked: true, tags: ["winter"], addedAfter: 1234 }
    });

    expect(mepRecipeDatabaseView).toHaveBeenCalledWith("/vault", {
      search: "salad",
      filter: { marked: true, tags: ["winter"], addedAfter: 1234 },
      recipesFolder: settings.recipesFolder,
      limit: settings.databaseMaxCards
    });
  });

  it("updates marked frontmatter via setMarked", async () => {
    const file = makeFile("recipes/alpha.md");
    const frontmatter = new Map<string, any>([["recipes/alpha.md", {}]]);
    const app = makeApp(frontmatter, [file]);
    const service = new RecipeIndexService(app, () => settings);

    await service.setMarked("recipes/alpha.md", true);
    expect(frontmatter.get("recipes/alpha.md").marked).toBe(true);

    await service.setMarked("recipes/alpha.md", false);
    expect(frontmatter.get("recipes/alpha.md").marked).toBeUndefined();
  });

  it("clears marked state for all marked recipes", async () => {
    const file = makeFile("recipes/alpha.md");
    const frontmatter = new Map<string, any>([["recipes/alpha.md", { marked: true }]]);
    const app = makeApp(frontmatter, [file]);
    const service = new RecipeIndexService(app, () => settings);

    mepRecipeDatabaseView.mockReturnValue({
      items: [
        {
          path: "recipes/alpha.md",
          title: "Alpha",
          coverPath: null,
          marked: true,
          added: null,
          scheduled: null,
          addedTimestamp: null,
          scheduledTimestamp: null,
          tags: []
        }
      ],
      total: 1,
      availableTags: [],
      markedCount: 1
    });

    await service.clearAllMarked();
    expect(frontmatter.get("recipes/alpha.md").marked).toBeUndefined();
  });

  it("rebuilds immediately after markDirty", () => {
    mepRecipeDatabaseView
      .mockReturnValueOnce({
        items: [],
        total: 0,
        availableTags: [],
        markedCount: 0
      })
      .mockReturnValueOnce({
        items: [
          {
            path: "recipes/alpha.md",
            title: "Alpha",
            coverPath: null,
            marked: false,
            added: "2026-01-01",
            scheduled: null,
            addedTimestamp: 0,
            scheduledTimestamp: null,
            tags: []
          }
        ],
        total: 1,
        availableTags: [],
        markedCount: 0
      });

    const app = makeApp(new Map());
    const service = new RecipeIndexService(app, () => settings);

    expect(service.queryRecipes().total).toBe(0);
    service.markDirty();
    expect(service.queryRecipes().total).toBe(1);
    expect(mepRecipeDatabaseView).toHaveBeenCalledTimes(2);
  });
});
