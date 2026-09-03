import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { listKitchenPaths, observeKitchen, readKitchenBytes } from "./doc";
import { SAMPLE_PATHS, seedSamplePack } from "./sample-pack";

const packPath = path.resolve("sample/sample-pack.pack");

describe("sample kitchen pack", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches one pack and seeds every sample in one transaction", async () => {
    const pack = await readFile(packPath);
    const fetch = vi.fn(async () => new Response(pack, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const doc = new Y.Doc();
    const transactions: string[][] = [];
    const stop = observeKitchen(doc, (paths) => transactions.push([...paths].sort()));

    await seedSamplePack(doc);
    stop();

    expect(fetch).toHaveBeenCalledOnce();
    const paths = listKitchenPaths(doc);
    expect(paths).toEqual([...SAMPLE_PATHS].sort());
    expect(transactions).toEqual([[...SAMPLE_PATHS].sort()]);
    const recipes = paths.filter((entry) => entry.endsWith(".md"));
    const covers = paths.filter((entry) => entry.startsWith("images/") && entry.endsWith(".webp"));
    expect(recipes).toHaveLength(11);
    expect(covers).toHaveLength(11);
    for (const entryPath of SAMPLE_PATHS) {
      const sourcePath = entryPath.startsWith("images/")
        ? path.resolve("sample", entryPath)
        : path.resolve("sample/recipes", entryPath);
      expect(readKitchenBytes(doc, entryPath)).toEqual(new Uint8Array(await readFile(sourcePath)));
    }
  });

  it("keeps the generated pack manifest aligned with canonical sample files", async () => {
    const recipes = (await readdir(path.resolve("sample/recipes"))).sort();
    const images = (await readdir(path.resolve("sample/images"))).sort().map((name) => `images/${name}`);
    expect(SAMPLE_PATHS).toEqual([...recipes, ...images]);
  });
});
