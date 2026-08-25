import { describe, expect, it } from "vitest";
import type { RecipeDatabaseItem } from "../../../pttNode";
import { compareRecipeDatabaseItems } from "./recipe-order";

const item = (path: string, title: string, addedTimestamp: number | null, marked = false): RecipeDatabaseItem => ({
  path,
  title,
  coverPath: null,
  marked,
  added: null,
  scheduled: null,
  scheduledDates: [],
  addedTimestamp,
  scheduledTimestamp: null,
  tags: []
});

describe("recipe database ordering", () => {
  it("uses normalized title then canonical path when primary dates tie", () => {
    const recipes = [
      item("recipes/Z.md", "same", 100),
      item("recipes/a.md", "Same", 100),
      item("recipes/b.md", "other", 100)
    ];
    recipes.sort((left, right) => compareRecipeDatabaseItems(left, right, "added-desc"));
    expect(recipes.map((recipe) => recipe.path)).toEqual([
      "recipes/b.md",
      "recipes/a.md",
      "recipes/Z.md"
    ]);
  });

  it("places null dates last in both directions without equating distinct paths", () => {
    const dated = item("recipes/dated.md", "Dinner", 100);
    const undated = item("recipes/undated.md", "Dinner", null);
    expect(compareRecipeDatabaseItems(dated, undated, "added-asc")).toBeLessThan(0);
    expect(compareRecipeDatabaseItems(dated, undated, "added-desc")).toBeLessThan(0);
    expect(compareRecipeDatabaseItems(item("recipes/a.md", "Dinner", 100), item("recipes/b.md", "Dinner", 100), "added-desc")).not.toBe(0);
    expect(compareRecipeDatabaseItems(item("recipes/a.md", "Dinner", 100), item("recipes/A.md", "Dinner", 100), "added-desc")).not.toBe(0);
  });
});
