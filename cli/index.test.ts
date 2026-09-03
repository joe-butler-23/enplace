import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildShoppingMarkdown, parseRecipe, renderImportedRecipe } from "../src/core";
import { execute } from "./index";

const folders: string[] = [];

async function folder(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "mep-cli-"));
  folders.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(folders.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("mep CLI", () => {
  it("adds the exact checked Markdown under recipes and refuses to overwrite it", async () => {
    const root = await folder();
    await mkdir(path.join(root, "recipes"));
    const markdown = renderImportedRecipe({
      title: "Red Lentil Soup",
      source: "https://example.test/soup",
      ingredients: ["1 cup red lentils"],
      method: ["Simmer"],
    });

    await expect(execute(["add", "-", "--folder", root], { stdin: markdown }))
      .resolves.toBe("recipes/red-lentil-soup.md\n");
    await expect(readFile(path.join(root, "recipes/red-lentil-soup.md"), "utf8")).resolves.toBe(markdown);
    await expect(execute(["add", "-", "--folder", root], { stdin: markdown }))
      .rejects.toThrow("refusing to overwrite recipes/red-lentil-soup.md");
  });

  it("rejects check input without the exact recipe heading", async () => {
    const root = await folder();
    await expect(execute(["check", "-", "--folder", root], { stdin: "# Soup\n\n### Ingredients\n- lentils\n" }))
      .rejects.toThrow("recipe needs an ## Ingredients heading");
  });

  it("writes and prints the core builder output for the selected plan week", async () => {
    const root = await folder();
    const soupMarkdown = renderImportedRecipe({ title: "Soup", ingredients: ["2 onions", "Salt"], method: [] });
    const pieMarkdown = renderImportedRecipe({ title: "Pie", ingredients: ["salt", "Flour"], method: [] });
    await writeFile(path.join(root, "soup.md"), soupMarkdown);
    await writeFile(path.join(root, "pie.md"), pieMarkdown);
    await writeFile(path.join(root, "Plan.md"), "## 2026-09-07\n- [[soup]]\n\n## 2026-09-09\n- [[pie]]\n");
    const current = "# Shopping\n\n## Soup\n- [x] 2 onions\n";
    await writeFile(path.join(root, "Shopping.md"), current);
    const recipes = [parseRecipe("soup.md", soupMarkdown)!, parseRecipe("pie.md", pieMarkdown)!];
    const expected = buildShoppingMarkdown(current, recipes, recipes);

    await expect(execute(["shop", "--week", "2026-09-10", "--folder", root])).resolves.toBe(expected);
    await expect(readFile(path.join(root, "Shopping.md"), "utf8")).resolves.toBe(expected);
  });
});
