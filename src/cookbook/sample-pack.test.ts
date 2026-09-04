import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { listCookbookPaths, observeCookbook, readCookbookBytes } from "./doc";
import { SAMPLE_PATHS, SAMPLE_RECIPE_PATHS, seedSamplePack } from "./sample-pack";

const packPath = path.resolve("sample/sample-pack.pack");

describe("sample cookbook pack", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches one pack and seeds recipes and their normalized covers in one transaction", async () => {
    const pack = await readFile(packPath);
    const fetch = vi.fn(async () => new Response(pack, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const doc = new Y.Doc();
    const transactions: string[][] = [];
    const stop = observeCookbook(doc, (paths) => transactions.push([...paths].sort()));

    await seedSamplePack(doc);
    stop();

    expect(fetch).toHaveBeenCalledOnce();
    const paths = listCookbookPaths(doc);
    expect(paths).toEqual([...SAMPLE_PATHS].sort());
    expect(transactions).toEqual([[...SAMPLE_PATHS].sort()]);
    expect(paths.filter((entry) => entry.endsWith(".md"))).toHaveLength(11);
    expect(paths.filter((entry) => entry.startsWith("images/"))).toHaveLength(22);
    for (const entryPath of SAMPLE_RECIPE_PATHS) {
      const bytes = readCookbookBytes(doc, entryPath);
      expect(bytes).toEqual(new Uint8Array(await readFile(path.resolve("sample/recipes", entryPath))));
      expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toMatch(/^cover: images\/[a-z-]+\.webp$/m);
    }
  });

  it("keeps exactly one capped cover and one card thumbnail per sample recipe", async () => {
    const recipes = (await readdir(path.resolve("sample/recipes"))).sort();
    expect(SAMPLE_RECIPE_PATHS).toEqual(recipes);
    const expectedCovers = recipes.flatMap((name) => {
      const stem = name.replace(/\.md$/, "");
      return [`${stem}.webp`, `${stem}.card.webp`];
    }).sort();
    expect((await readdir(path.resolve("sample/images"))).sort()).toEqual(expectedCovers);
    for (const name of expectedCovers) {
      expect((await readFile(path.resolve("sample/images", name))).byteLength, name).toBeGreaterThan(0);
    }
  });
});
