import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plan, Recipe } from "@/core";
import { DEFAULT_STANDALONE_SETTINGS as SETTINGS } from "@/standalone/settings";
import { buildDatabaseView, databaseQuery, initialDatabaseState } from "./database-query";
const recipe = (index: number, overrides: Partial<Recipe> = {}): Recipe => ({ path: `recipes/recipe-${index}.md`,
  title: `Recipe ${index}`, ingredients: [], cover: null, added: null, tags: [], link: `Recipe ${index}`, ...overrides });
const plan = (overrides: Partial<Plan> = {}): Plan => ({ marked: [], days: new Map(), notes: new Map(), ...overrides });
const paths = (recipes: readonly Recipe[], query: Parameters<typeof buildDatabaseView>[2] = {}, cookbookPlan = plan()) =>
  buildDatabaseView(recipes, cookbookPlan, query).items.map(({ path }) => path);
afterEach(() => vi.useRealTimers());
describe("database query projection", () => {
  it("starts from saved preferences", () => expect(initialDatabaseState({ ...SETTINGS, databaseSort: "title-desc",
    databaseMarkedFilter: "marked", databaseScheduledFilter: "unscheduled" })).toEqual({ search: "", sort: "title-desc",
      marked: "marked", scheduled: "unscheduled", added: "all", tags: [] }));
  it.each([["marked", "marked", true], ["marked", "unmarked", false], ["marked", "all", undefined],
    ["scheduled", "scheduled", true], ["scheduled", "unscheduled", false], ["scheduled", "all", undefined]] as const)(
    "maps %s=%s without collapsing its tri-state", (field, value, expected) => {
      const query = databaseQuery({ ...initialDatabaseState(SETTINGS), [field]: value });
      expect(query.filter?.[field]).toBe(expected);
    });
  it("maps every other owned field and the cap", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 10, 15, 30));
    expect(databaseQuery({ ...initialDatabaseState(SETTINGS), search: "aubergine", sort: "title-desc", added: "last-7-days",
      tags: ["quick", "vegan"] })).toEqual({ sortBy: "title-desc", filter: { marked: undefined, scheduled: undefined,
        tags: ["quick", "vegan"], addedAfter: new Date(2026, 8, 3).getTime() }, search: "aubergine", limit: 500 });
  });
  it("requires all tags without help from another filter", () => {
    const both = recipe(1, { tags: ["quick", "vegan"] });
    expect(paths([both, recipe(2, { tags: ["quick"] }), recipe(3, { tags: ["vegan"] })],
      { filter: { tags: ["quick", "vegan"] } })).toEqual([both.path]);
  });
  it.each([["summer", "recipes/recipe-1.md"], ["SOUP-NIGHT", "recipes/SOUP-night.md"]])(
    "searches title/path case-insensitively for %s", (search, expected) => expect(paths([
      recipe(1, { title: "Summer Soup" }), recipe(2, { path: "recipes/SOUP-night.md" })], { search })).toEqual([expected]));
  it("uses inclusive local midnight seven days ago", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 10, 15, 30));
    const query = databaseQuery({ ...initialDatabaseState(SETTINGS), added: "last-7-days" });
    expect(paths([recipe(1, { added: new Date(2026, 8, 3).toISOString() }),
      recipe(2, { added: new Date(2026, 8, 2, 23, 59).toISOString() })], query)).toEqual(["recipes/recipe-1.md"]);
  });
  it.each([["title-asc", ["Alpha", "Beta", "Missing"]], ["title-desc", ["Missing", "Beta", "Alpha"]],
    ["added-asc", ["Missing", "Alpha", "Beta"]], ["added-desc", ["Beta", "Alpha", "Missing"]],
    ["scheduled-asc", ["Alpha", "Missing", "Beta"]], ["scheduled-desc", ["Beta", "Missing", "Alpha"]]] as const)(
    "preserves %s ordering including missing dates", (sortBy, titles) => {
      const recipes = [recipe(1, { title: "Beta", added: "2026-02-02", link: "Beta" }),
        recipe(2, { title: "Alpha", added: "2026-01-01", link: "Alpha" }), recipe(3, { title: "Missing", link: "Missing" })];
      const result = buildDatabaseView(recipes, plan({ days: new Map([["2026-03-02", ["Beta"]], ["2026-03-01", ["Missing"]]]) }), { sortBy });
      expect(result.items.map(({ title }) => title)).toEqual(titles);
    });
  it("reports pre-limit total but global tags and marked count", () => {
    const recipes = Array.from({ length: 510 }, (_, index) => recipe(index, { tags: index === 509 ? ["global"] : [] }));
    const view = buildDatabaseView(recipes, plan({ marked: [recipes[509].link] }), { limit: 500 });
    expect([view.items.length, view.total, view.availableTags, view.markedCount]).toEqual([500, 510, ["global"], 1]);
  });
  it("keeps a 300-recipe tail item searchable", () => {
    const recipes = Array.from({ length: 300 }, (_, index) => recipe(index, { title: index === 299 ? "Needle aubergine" : `Haystack ${index}` }));
    expect(paths(recipes, { search: "needle", limit: 500 })).toEqual(["recipes/recipe-299.md"]);
  });
});
