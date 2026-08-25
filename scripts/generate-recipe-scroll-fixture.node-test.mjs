import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { createRecipeScrollFixture } from "./generate-recipe-scroll-fixture.mjs";

test("recipe scroll fixture creates deterministic raster covers and recipe metadata", async () => {
  const fixture = await createRecipeScrollFixture({ count: 3 });
  try {
    const vaultEntries = (await readdir(fixture.vaultRoot)).sort();
    const recipes = await readdir(`${fixture.vaultRoot}/recipes`);
    const images = (await readdir(`${fixture.vaultRoot}/recipes/images`)).sort();
    const configEntries = (await readdir(`${fixture.vaultRoot}/.mep`)).sort();
    const inboxEntries = (await readdir(`${fixture.vaultRoot}/inbox`)).sort();
    const settings = JSON.parse(
      await readFile(`${fixture.appDataRoot}/settings.json`, "utf8")
    );
    assert.deepEqual(vaultEntries, [".mep", "events", "inbox", "recipes"]);
    assert.equal(recipes.filter((name) => name.endsWith(".md")).length, 3);
    assert.deepEqual(images, [
      "visual-cover-001.png",
      "visual-cover-002.png",
      "visual-cover-003.png"
    ]);
    assert.deepEqual(configEntries, []);
    assert.deepEqual(inboxEntries, ["archive"]);
    assert.equal(settings.recipesFolder, "recipes");
    assert.equal(settings.imagesFolder, "recipes/images");
    assert.equal(settings.vaultPath, "/home/vault");

    const firstImage = await readFile(`${fixture.vaultRoot}/recipes/images/visual-cover-001.png`);
    const secondImage = await readFile(`${fixture.vaultRoot}/recipes/images/visual-cover-002.png`);
    assert.deepEqual(firstImage.subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));
    assert.deepEqual(secondImage.subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));
    assert.notDeepEqual(firstImage, secondImage);

    const recipe = await readFile(`${fixture.vaultRoot}/recipes/visual-fixture-001.md`, "utf8");
    assert.match(recipe, /title: "Visual Fixture 001"/);
    assert.match(recipe, /cover: "images\/visual-cover-001\.png"/);
    assert.match(recipe, /!\[Visual fixture image\]\(images\/visual-cover-001\.png\)/);
  } finally {
    await fixture.cleanup();
  }
});
