import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { listKitchenPaths, readKitchenBytes } from "./doc";
import { SAMPLE_PATHS, seedSamplePack } from "./sample-pack";

describe("sample kitchen pack", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("seeds 11 recipes and their covers into a persist-free document", async () => {
    vi.stubGlobal("fetch", vi.fn(async (value: string | URL | Request) => {
      const url = String(value);
      return new Response(new TextEncoder().encode(url), { status: 200 });
    }));
    const doc = new Y.Doc();

    await seedSamplePack(doc);

    const paths = listKitchenPaths(doc);
    expect(paths).toEqual(SAMPLE_PATHS);
    const recipes = paths.filter((path) => path.endsWith(".md"));
    const covers = paths.filter((path) => path.startsWith("images/") && path.endsWith(".webp"));
    expect(recipes).toHaveLength(11);
    expect(covers).toHaveLength(11);
    for (const recipe of recipes) {
      const slug = recipe.replace(/\.md$/, "");
      expect(readKitchenBytes(doc, `images/${slug}.webp`)).not.toBeNull();
    }
  });
});
