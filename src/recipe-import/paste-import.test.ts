import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRecipe } from "../core";

const { createCoverFiles, writeNewBytesBatch } = vi.hoisted(() => ({
  createCoverFiles: vi.fn(), writeNewBytesBatch: vi.fn(),
}));
vi.mock("../cookbook/covers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cookbook/covers")>();
  return { ...actual, createCoverFiles };
});
vi.mock("../host-client/browser-storage", () => ({ writeNewBytesBatch }));
import { importPastedRecipe, RECIPE_REJECTION_MESSAGE } from "./paste-import";

const markdown = `# Tomato Soup

A simple soup.

---

- *4* tomatoes
- *1 litre* stock

---

1. Simmer.
`;

afterEach(() => vi.useRealTimers());

describe("pasted RecipeMD import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeNewBytesBatch.mockResolvedValue(3);
    createCoverFiles.mockResolvedValue({
      cover: new Uint8Array([4, 5]), thumbnail: new Uint8Array([6]),
    });
  });

  it("validates and stores complete Markdown with optimized cover files", async () => {
    const raw = new Uint8Array([1, 2, 3]);
    const cover = new File([raw], "Huge Camera.JPG", { type: "image/jpeg" });
    await expect(importPastedRecipe({ markdown, cover })).resolves.toEqual({
      markdownPath: "tomato-soup.md", title: "Tomato Soup", ingredientCount: 2,
    });

    expect(createCoverFiles).toHaveBeenCalledWith(cover);
    const [entries, existing] = writeNewBytesBatch.mock.calls[0];
    expect(existing).toBe("reject");
    expect(entries.map(([path]: readonly [string, Uint8Array]) => path)).toEqual([
      "tomato-soup.md", "images/tomato-soup.webp", "images/tomato-soup.card.webp",
    ]);
    expect(new TextDecoder().decode(entries[0][1])).toContain("![Tomato Soup](<images/tomato-soup.webp>)");
    expect(entries[1][1]).toEqual(new Uint8Array([4, 5]));
    expect(entries[2][1]).toEqual(new Uint8Array([6]));
    expect(entries.some(([, bytes]: readonly [string, Uint8Array]) => bytes === raw)).toBe(false);
  });

  it("records each new import time without replacing a supplied added date", async () => {
    vi.useFakeTimers();
    const first = "2026-09-07T10:00:00.000Z", second = "2026-09-07T11:00:00.000Z";
    vi.setSystemTime(first);
    await importPastedRecipe({ markdown });
    vi.setSystemTime(second);
    await importPastedRecipe({ markdown: markdown.replace("Tomato Soup", "Zucchini Soup") });
    const imported = writeNewBytesBatch.mock.calls.map(([entries]) => new TextDecoder().decode(entries[0][1]));
    expect(imported.map(text => parseRecipe("recipe.md", text)?.added)).toEqual([first, second]);
    expect(imported[0].replace(`Added: ${first}\n\n`, "")).toBe(markdown);
    await importPastedRecipe({ markdown: imported[0] });
    const [entries] = writeNewBytesBatch.mock.calls[2];
    expect(new TextDecoder().decode(entries[0][1])).toBe(imported[0]);
  });

  it("rejects non-recipe Markdown with a plain-language message", async () => {
    await expect(importPastedRecipe({ markdown: "# Travel notes\n\nRemember the market." }))
      .rejects.toThrow(RECIPE_REJECTION_MESSAGE);
    expect(writeNewBytesBatch).not.toHaveBeenCalled();
  });
});
