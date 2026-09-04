import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderImportedRecipe } from "../src/core";
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

  it("keeps exact check output and the strict Ingredients policy", async () => {
    const root = await folder();
    const check = (stdin: string) => execute(["check", "-", "--folder", root], { stdin });

    await expect(check("---\r\ntitle: \"CLI Soup\"\r\n---\r\n## Ingredients\r\n- lentils\r\n"))
      .resolves.toBe("OK: CLI Soup -> cli-soup.md\n");
    for (const stdin of [
      "# Soup\n\n### Ingredients\n- lentils\n",
      "# Soup\n\n## Ingredients deluxe\n- lentils\n",
    ]) {
      await expect(check(stdin)).rejects.toThrow("recipe needs an ## Ingredients heading");
    }
    await expect(check("---\ntitle: Display Only\n---junk\n# Strict Title\n## Ingredients\n- lentils"))
      .resolves.toBe("OK: Strict Title -> strict-title.md\n");
  });

  it.each([
    { argv: [], error: "usage: mep <check|add|list|shop|mirror> [options]\n       mep mirror --folder <dir> --kitchen <link-or-id> [--relay <wss-url>] [--once]" },
    { argv: ["unknown"], error: "usage: mep <check|add|list|shop|mirror> [options]\n       mep mirror --folder <dir> --kitchen <link-or-id> [--relay <wss-url>] [--once]" },
    { argv: ["--"], error: "unknown option: --" },
    { argv: ["list", "--other"], error: "unknown option: --other" },
    { argv: ["list", "--folder"], error: "--folder needs a value" },
    { argv: ["list", "--folder", "--json"], error: "--folder needs a value" },
    { argv: ["check"], error: "check needs one <file|->" },
    { argv: ["add", "one", "two"], error: "add needs one <file|->" },
    { argv: ["list", "file"], error: "list takes no file argument" },
    { argv: ["shop", "file"], error: "shop takes no file argument" },
    { argv: ["mirror", "file"], error: "mirror takes no file argument" },
    { argv: ["list", "--week", "2026-09-07"], error: "--week is only valid with shop" },
    { argv: ["list", "--kitchen", "id"], error: "--kitchen, --relay, and --once are only valid with mirror" },
    { argv: ["list", "--relay", "wss://relay.test"], error: "--kitchen, --relay, and --once are only valid with mirror" },
    { argv: ["list", "--once"], error: "--kitchen, --relay, and --once are only valid with mirror" },
    { argv: ["mirror"], error: "mirror needs --folder <dir>" },
  ])("rejects $argv with the literal argument error", async ({ argv, error }) => {
    await expect(execute(argv)).rejects.toThrow(error);
  });

  it("keeps mirror validation order and relative folder resolution", async () => {
    const root = await folder();
    await expect(execute(["mirror", "--folder", root])).rejects.toThrow("mirror needs --kitchen <link-or-id>");
    await expect(execute(["mirror", "--folder", root, "--kitchen", "id", "--json"]))
      .rejects.toThrow("--json is not valid with mirror");
    await expect(execute(["list", "--folder", "missing"], { cwd: root }))
      .rejects.toThrow(`folder not found: ${path.join(root, "missing")}`);
  });

  it("keeps exact JSON output for check and add with options around the command", async () => {
    const root = await folder();
    const markdown = "# Tomato Soup\n\n## Ingredients\n- tomatoes\n";
    await expect(execute(["--json", "check", "-", "--folder", root], { stdin: markdown })).resolves.toBe(
      "{\n  \"title\": \"Tomato Soup\",\n  \"path\": \"tomato-soup.md\"\n}\n",
    );
    await expect(execute(["--folder", root, "add", "-", "--json"], { stdin: markdown })).resolves.toBe(
      "{\n  \"path\": \"tomato-soup.md\"\n}\n",
    );
  });

  it("lists duplicate-title recipes with case-colliding stems", async () => {
    const root = await folder();
    const recipes = [
      ["recipes/Soup.md", "onion"],
      ["archive/soup.MD", "lentils"],
    ] as const;
    await Promise.all(recipes.map(async ([relativePath, ingredient]) => {
      const file = path.join(root, relativePath);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `---\ntitle: Shared Supper\n---\n## Ingredients\n- ${ingredient}`);
    }));

    const rows = JSON.parse(await execute(["list", "--json", "--folder", root])) as Array<Record<string, unknown>>;
    expect(rows.sort((left, right) => String(left.path).localeCompare(String(right.path)))).toEqual([
      { path: "archive/soup.MD", title: "Shared Supper", tags: [], cover: false },
      { path: "recipes/Soup.md", title: "Shared Supper", tags: [], cover: false },
    ]);
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
    const expected = "# Shopping\n\n## Soup\n- [x] 2 onions\n- [ ] Salt\n\n## Pie\n- [ ] Flour\n";

    await expect(execute(["shop", "--week", "2026-09-10", "--folder", root])).resolves.toBe(expected);
    await expect(readFile(path.join(root, "Shopping.md"), "utf8")).resolves.toBe(expected);
  });
  it("keeps shop date errors and exact JSON output", async () => {
    const root = await folder();
    await expect(execute(["shop", "--week", "2026/09/07", "--folder", root]))
      .rejects.toThrow("--week needs YYYY-MM-DD");
    await expect(execute(["shop", "--week", "2026-02-30", "--folder", root]))
      .rejects.toThrow("--week needs a valid date");
    await writeFile(path.join(root, "Plan.md"), "");
    await expect(execute(["shop", "--week", "2026-09-10", "--folder", root, "--json"]))
      .resolves.toBe("{\n  \"week\": \"2026-09-07\",\n  \"path\": \"Shopping.md\",\n  \"markdown\": \"\"\n}\n");
    await expect(readFile(path.join(root, "Shopping.md"), "utf8")).resolves.toBe("");
  });

  it("keeps CLI day/entry order, skips missing references, and preserves duplicate-title identities", async () => {
    const root = await folder();
    await mkdir(path.join(root, "a")); await mkdir(path.join(root, "b"));
    await writeFile(path.join(root, "a/meal.md"), renderImportedRecipe({ title: "Same", ingredients: ["first"], method: [] }));
    await writeFile(path.join(root, "b/meal.md"), renderImportedRecipe({ title: "Same", ingredients: ["second"], method: [] }));
    await writeFile(path.join(root, "Plan.md"), "## 2026-09-07\n- [[b/meal]]\n- [[missing]]\n- [[a/meal]]\n- [[b/meal]]\n");

    const expected = "## Same\n- [ ] second\n\n## Same\n- [ ] first\n";
    await expect(execute(["shop", "--week", "2026-09-07", "--folder", root])).resolves.toBe(expected);
    await expect(readFile(path.join(root, "Shopping.md"), "utf8")).resolves.toBe(expected);
  });

});
