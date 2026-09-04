import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { deleteCookbookPath, listCookbookPaths, observeCookbook, readCookbookBytes } from "./doc";
import {
  SAMPLE_COVER_PATHS, SAMPLE_PATHS, SAMPLE_RECIPE_PATHS, SAMPLE_SEED_PATHS,
  seedSampleCovers, seedSamplePack,
} from "./sample-pack";

const seedPackPath = path.resolve("sample/sample-pack.pack");
const coversPackPath = path.resolve("sample/sample-covers.pack");

function stubPacks(...packs: Buffer[]): ReturnType<typeof vi.fn> {
  const responses = packs.map((pack) => () => new Response(pack, { status: 200 }));
  const fetch = vi.fn(async () => responses.shift()!());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("sample cookbook packs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("seeds recipes and card thumbnails from one pack, without the full covers", async () => {
    const fetch = stubPacks(await readFile(seedPackPath));
    const doc = new Y.Doc();
    const transactions: string[][] = [];
    const stop = observeCookbook(doc, (paths) => transactions.push([...paths].sort()));

    await seedSamplePack(doc);
    stop();

    expect(fetch).toHaveBeenCalledOnce();
    const paths = listCookbookPaths(doc);
    expect(paths).toEqual([...SAMPLE_SEED_PATHS].sort());
    expect(transactions).toEqual([[...SAMPLE_SEED_PATHS].sort()]);
    expect(paths.filter((entry) => entry.endsWith(".md"))).toHaveLength(11);
    expect(paths.filter((entry) => entry.endsWith(".card.webp"))).toHaveLength(11);
    // The grid paints from this pack alone; nothing here is a full-size cover.
    for (const coverPath of SAMPLE_COVER_PATHS) expect(paths).not.toContain(coverPath);
    for (const entryPath of SAMPLE_RECIPE_PATHS) {
      const bytes = readCookbookBytes(doc, entryPath);
      expect(bytes).toEqual(new Uint8Array(await readFile(path.resolve("sample/recipes", entryPath))));
      expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toMatch(/^!\[[^\]]+\]\(<images\/[a-z-]+\.webp>\)$/m);
    }
  });

  it("adds the full covers from the second pack in one later transaction", async () => {
    stubPacks(await readFile(seedPackPath), await readFile(coversPackPath));
    const doc = new Y.Doc();
    await seedSamplePack(doc);

    const transactions: string[][] = [];
    const stop = observeCookbook(doc, (paths) => transactions.push([...paths].sort()));
    await seedSampleCovers(doc);
    stop();

    expect(transactions).toEqual([[...SAMPLE_COVER_PATHS].sort()]);
    expect(listCookbookPaths(doc)).toEqual([...SAMPLE_PATHS].sort());
  });

  it("does not restore covers for samples removed while the pack was in flight", async () => {
    stubPacks(await readFile(seedPackPath), await readFile(coversPackPath));
    const doc = new Y.Doc();
    await seedSamplePack(doc);
    const kept = SAMPLE_RECIPE_PATHS[0];
    for (const recipePath of SAMPLE_RECIPE_PATHS) {
      if (recipePath !== kept) deleteCookbookPath(doc, recipePath);
    }

    await seedSampleCovers(doc);

    const covers = listCookbookPaths(doc).filter((entry) =>
      entry.startsWith("images/") && !entry.endsWith(".card.webp"));
    expect(covers).toEqual([`images/${kept.replace(/\.md$/, "")}.webp`]);
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

  it("keeps the blocking pack smaller than the covers it defers", async () => {
    const seed = (await readFile(seedPackPath)).byteLength;
    const covers = (await readFile(coversPackPath)).byteLength;
    expect(seed).toBeLessThan(covers);
    // First paint must not carry the full covers: the old single pack was 972 KB.
    expect(seed).toBeLessThan(400_000);
  });
});
