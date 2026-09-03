import { describe, expect, it } from "vitest";
import { parsePlan, scanRecipes } from "@/core";
import { createWeeklyOrganiserConfig } from "../boards/weeklyOrganiserConfig";
import { buildBoardEntries } from "./buildBoardsData";

describe("weekly board data", () => {
  it("builds marked and multi-date entries directly from recipes and Plan.md", () => {
    const recipes = scanRecipes([
      { path: "Recipes/Soup.md", text: "---\ntitle: Soup\n---\n## Ingredients\n- onion\n" },
      { path: "Recipes/Pie.md", text: "---\ntitle: Pie\n---\n## Ingredients\n- flour\n" },
    ]);
    const plan = parsePlan("## Marked\n- [[Pie]]\n\n## 2026-09-07\n- [[Soup]]\n\n## 2026-09-09\n- [[Soup]]\n");
    const config = createWeeklyOrganiserConfig(0);
    config.columns = [
      { id: "marked", title: "Marked", fieldValue: undefined, isDefault: true },
      { id: "2026-09-07", title: "Monday", fieldValue: "2026-09-07" },
      { id: "2026-09-09", title: "Wednesday", fieldValue: "2026-09-09" },
    ];

    const board = buildBoardEntries(recipes, plan, config);

    expect([...board.entriesByItemId.keys()].sort()).toEqual([
      "Recipes/Pie.md::marked",
      "Recipes/Soup.md::2026-09-07",
      "Recipes/Soup.md::2026-09-09",
    ]);
    expect(board.entriesByColumn.get("2026-09-09")?.[0].item).toMatchObject({
      path: "Recipes/Soup.md",
      title: "Soup",
      date: "2026-09-09",
    });
  });
});
