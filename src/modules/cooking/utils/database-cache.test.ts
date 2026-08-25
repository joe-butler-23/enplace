import { describe, expect, it } from "vitest";
import type { RecipeDatabaseView } from "../../../pttNode";
import { projectMarkedInDatabaseViews } from "./database-cache";

const view = (items: RecipeDatabaseView["items"], total: number): RecipeDatabaseView => ({
  items,
  total,
  availableTags: [],
  markedCount: 1
});

const item = (path: string, marked: boolean) => ({
  path,
  title: "Dinner",
  coverPath: null,
  marked,
  added: "2026-01-01",
  scheduled: null,
  scheduledDates: [],
  addedTimestamp: 1,
  scheduledTimestamp: null,
  tags: []
});

describe("database cache mark projection", () => {
  it("updates every cached filter and keeps canonical order", () => {
    const marked = item("recipes/a.md", true);
    const other = item("recipes/b.md", false);
    const cache = new Map([
      [JSON.stringify({ sortBy: "added-desc", filter: { marked: true }, limit: 20 }), view([marked], 1)],
      [JSON.stringify({ sortBy: "added-desc", filter: { marked: false }, limit: 20 }), view([other], 1)],
      [JSON.stringify({ sortBy: "added-desc", filter: {}, limit: 20 }), view([marked, other], 2)]
    ]);

    projectMarkedInDatabaseViews(cache, marked.path, false);

    const entries = [...cache.values()];
    expect(entries[0]?.items).toEqual([]);
    expect(entries[0]?.total).toBe(0);
    expect(entries[1]?.items.map((entry) => entry.path)).toEqual(["recipes/a.md", "recipes/b.md"]);
    expect(entries[1]?.total).toBe(2);
    expect(entries[2]?.items.find((entry) => entry.path === marked.path)?.marked).toBe(false);
    expect(entries.every((entry) => entry.markedCount === 0)).toBe(true);
  });
});
