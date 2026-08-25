import { describe, expect, it } from "vitest";
import { exists, readDir, readTextFile } from "./fs";

describe("shim deterministic seed", () => {
  it("creates fixture markdown files under /home/vault", async () => {
    const fixturePath = "/home/vault/recipes/fixture-coq-au-riesling.md";
    const hasFixture = await exists(fixturePath);
    const entries = await readDir('/home/vault');
    const head = hasFixture ? await readTextFile(fixturePath) : "";
    const recipesDir = entries.find((entry) => entry.name === "recipes");

    expect(hasFixture).toBe(true);
    expect(recipesDir?.isDirectory).toBe(true);
    expect(recipesDir?.isFile).toBe(false);
    expect(head).toContain('type: "recipe"');
  });
});
