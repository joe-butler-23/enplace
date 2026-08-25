import { describe, expect, it } from "vitest";
import { splitViewportPaths } from "./thumbnail-batching";

interface TestItem {
  id: number;
  cover: string | null;
}

function extract(item: TestItem): string | null {
  return item.cover;
}

describe("splitViewportPaths", () => {
  it("returns empty batches for empty input", () => {
    const result = splitViewportPaths([], 24, extract);
    expect(result.firstBatch).toEqual([]);
    expect(result.restBatch).toEqual([]);
  });

  it("puts all paths in first batch when fewer items than viewport size", () => {
    const items: TestItem[] = [
      { id: 1, cover: "/a.jpg" },
      { id: 2, cover: "/b.jpg" },
      { id: 3, cover: "/c.jpg" },
    ];
    const result = splitViewportPaths(items, 24, extract);
    expect(result.firstBatch).toEqual(["/a.jpg", "/b.jpg", "/c.jpg"]);
    expect(result.restBatch).toEqual([]);
  });

  it("splits items at the viewport boundary", () => {
    const items: TestItem[] = [
      { id: 1, cover: "/a.jpg" },
      { id: 2, cover: "/b.jpg" },
      { id: 3, cover: "/c.jpg" },
      { id: 4, cover: "/d.jpg" },
      { id: 5, cover: "/e.jpg" },
    ];
    const result = splitViewportPaths(items, 3, extract);
    expect(result.firstBatch).toEqual(["/a.jpg", "/b.jpg", "/c.jpg"]);
    expect(result.restBatch).toEqual(["/d.jpg", "/e.jpg"]);
  });

  it("deduplicates paths within and across batches (first occurrence wins)", () => {
    const items: TestItem[] = [
      { id: 1, cover: "/a.jpg" },
      { id: 2, cover: "/b.jpg" },
      { id: 3, cover: "/a.jpg" }, // duplicate
      { id: 4, cover: "/c.jpg" },
      { id: 5, cover: "/b.jpg" }, // duplicate, in rest
    ];
    const result = splitViewportPaths(items, 3, extract);
    // First 3 items: a, b, a (deduped to a, b)
    expect(result.firstBatch).toEqual(["/a.jpg", "/b.jpg"]);
    // Rest: c, b (b already seen, deduped to c)
    expect(result.restBatch).toEqual(["/c.jpg"]);
  });

  it("handles items with null covers (no path)", () => {
    const items: TestItem[] = [
      { id: 1, cover: null },
      { id: 2, cover: "/b.jpg" },
      { id: 3, cover: null },
      { id: 4, cover: "/d.jpg" },
    ];
    const result = splitViewportPaths(items, 2, extract);
    // First 2 items: null, b → firstBatch = [b]
    expect(result.firstBatch).toEqual(["/b.jpg"]);
    // Rest: null, d → restBatch = [d]
    expect(result.restBatch).toEqual(["/d.jpg"]);
  });

  it("handles zero viewport size (degenerate, all items to rest)", () => {
    const items: TestItem[] = [
      { id: 1, cover: "/a.jpg" },
      { id: 2, cover: "/b.jpg" },
    ];
    const result = splitViewportPaths(items, 0, extract);
    expect(result.firstBatch).toEqual([]);
    expect(result.restBatch).toEqual(["/a.jpg", "/b.jpg"]);
  });

  it("handles negative viewport size (degenerate, all items to rest)", () => {
    const items: TestItem[] = [
      { id: 1, cover: "/a.jpg" },
    ];
    const result = splitViewportPaths(items, -1, extract);
    expect(result.firstBatch).toEqual([]);
    expect(result.restBatch).toEqual(["/a.jpg"]);
  });

  it("preserves view order within each batch", () => {
    const items: TestItem[] = [
      { id: 1, cover: "/z.jpg" },
      { id: 2, cover: "/a.jpg" },
      { id: 3, cover: "/m.jpg" },
      { id: 4, cover: "/b.jpg" },
    ];
    const result = splitViewportPaths(items, 2, extract);
    expect(result.firstBatch).toEqual(["/z.jpg", "/a.jpg"]);
    expect(result.restBatch).toEqual(["/m.jpg", "/b.jpg"]);
  });

  it("works with remote URLs (treated as opaque strings)", () => {
    const items: TestItem[] = [
      { id: 1, cover: "https://cdn.example.com/a.jpg" },
      { id: 2, cover: "https://cdn.example.com/b.jpg" },
      { id: 3, cover: "https://cdn.example.com/a.jpg" }, // duplicate
    ];
    const result = splitViewportPaths(items, 2, extract);
    expect(result.firstBatch).toEqual([
      "https://cdn.example.com/a.jpg",
      "https://cdn.example.com/b.jpg",
    ]);
    expect(result.restBatch).toEqual([]);
  });
});
