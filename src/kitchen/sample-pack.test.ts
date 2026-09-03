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
    expect(recipes).toHaveLength(11);
    expect(paths.some((entry) => entry.startsWith("images/"))).toBe(false);
    for (const entryPath of SAMPLE_PATHS) {
      const bytes = readKitchenBytes(doc, entryPath);
      expect(bytes).toEqual(new Uint8Array(await readFile(path.resolve("sample/recipes", entryPath))));
      // Covers are stable URLs under public/samples, so the pack carries no image bytes.
      expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toMatch(/^cover: \/samples\/[a-z-]+\.webp$/m);
    }
  });

  it("keeps the generated pack manifest aligned with canonical sample files", async () => {
    const recipes = (await readdir(path.resolve("sample/recipes"))).sort();
    expect(SAMPLE_PATHS).toEqual(recipes);
    expect((await readdir(path.resolve("public/samples"))).sort()).toEqual(recipes.map((name) => name.replace(/\.md$/, ".webp")));
  });
});
