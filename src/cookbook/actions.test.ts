import { newCookbookId } from "./doc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCookbook, type CookbookConnection } from "../host-client/cookbook-storage";
import { readText } from "../host-client/browser-storage";
import { parsePlan, parseRecipe } from "../core";
import { writeCookbookText } from "./doc";
import { currentCookbookConnection, setCurrentCookbookConnection } from "./current";
import { applyShoppingPlan, deleteRecipe, saveRecipe, toggleShopping, updatePlanRecipe } from "./actions";

const connections: CookbookConnection[] = [];

async function selectCookbook(path: string, text: string): Promise<void> {
  const connection = await openCookbook({
    id: newCookbookId(),
    relayUrl: null,
    persist: false,
  });
  writeCookbookText(connection.doc, path, text);
  connections.push(connection);
  setCurrentCookbookConnection(connection);
}

async function selectShoppingCookbook(shopping: string) {
  await selectCookbook("a/first.md", "---\ntitle: Same\n---\n## Ingredients\n- first only");
  const connection = currentCookbookConnection()!;
  writeCookbookText(connection.doc, "z/second.md", "---\ntitle: Same\n---\n## Ingredients\n- second only");
  writeCookbookText(connection.doc, "malformed.md", "# Malformed");
  writeCookbookText(connection.doc, "Shopping.md", shopping);
  return vi.spyOn(connection.adapter, "updateText");
}

afterEach(async () => {
  vi.restoreAllMocks();
  setCurrentCookbookConnection(null);
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
});

describe("recipe actions", () => {
  it("merges a stale editor draft with the current cookbook text", async () => {
    const base = "first: base\nsecond: base\n";
    await selectCookbook("recipes/soup.md", "first: base\nsecond: remote\n");

    const result = await saveRecipe("recipes/soup.md", base, "first: local\nsecond: base\n");

    expect(result).toEqual({ text: "first: local\nsecond: remote\n", conflicts: 0 });
    await expect(readText("recipes/soup.md")).resolves.toBe(result.text);
  });

  it("removes a recipe through the current cookbook authority", async () => {
    await selectCookbook("recipes/soup.md", "# Soup\n");
    await deleteRecipe("recipes/soup.md");
    await expect(readText("recipes/soup.md")).rejects.toThrow("File not found");
  });

  it("applies concurrent recipe planning changes to live text", async () => {
    await selectCookbook("Plan.md", "## Marked\n");
    const one = parseRecipe("one.md", "# One\n\n## Ingredients\n- one thing\n")!;
    const two = parseRecipe("two.md", "# Two\n\n## Ingredients\n- two things\n")!;

    await Promise.all([
      updatePlanRecipe(one, (planning) => ({ ...planning, marked: true })),
      updatePlanRecipe(two, (planning) => ({ ...planning, marked: true })),
    ]);

    expect(parsePlan(await readText("Plan.md")).marked).toEqual(["one", "two"]);
  });
});

describe("browser shopping recipe selection", () => {
  it("writes one exact path-sorted build for distinct recipe paths", async () => {
    const updateText = await selectShoppingCookbook(
      "# Handwritten\r\nKeep this exactly.\r\n\r\n## Same\r\n- [x] SECOND ONLY\r\nOld owned bytes\r\n\r\n## Manual\r\n- [ ] note\r\n",
    );

    await applyShoppingPlan(["z/second.md", "a/first.md", "z/second.md"]);

    expect(updateText).toHaveBeenCalledTimes(1);
    expect(updateText.mock.calls[0]?.[0]).toBe("Shopping.md");
    await expect(readText("Shopping.md")).resolves.toBe(
      "# Handwritten\r\nKeep this exactly.\r\n\r\n## Manual\r\n- [ ] note\r\n\n## Same\n- [ ] first only\n\n## Same\n- [ ] second only\n",
    );
  });

  it("cleans recipe sections with one write for zero selections", async () => {
    const updateText = await selectShoppingCookbook("# Handwritten\r\nKeep.\r\n\r\n## Same\r\n- [ ] stale\r\n\r\n## Manual\r\n- [x] exact\r\n");

    await applyShoppingPlan([]);

    expect(updateText).toHaveBeenCalledTimes(1);
    await expect(readText("Shopping.md")).resolves.toBe("# Handwritten\r\nKeep.\r\n\r\n## Manual\r\n- [x] exact\r\n");
  });

  it("fails closed without writing for every missing or malformed path", async () => {
    const before = "## Manual\n- [x] untouched\n";
    const updateText = await selectShoppingCookbook(before);

    await expect(applyShoppingPlan(["missing/z.md", "a/first.md", "malformed.md", "missing/z.md"]))
      .rejects.toThrow("Missing scheduled recipe files: malformed.md, missing/z.md");
    expect(updateText).not.toHaveBeenCalled();
    await expect(readText("Shopping.md")).resolves.toBe(before);
  });
});

it("ticks every merged member with one live text update", async () => {
  await selectCookbook("Shopping.md", "## Pie\n- [x] *1* aubergine, diced\n\n## Soup\n- [ ] *1* aubergine, sliced\n");
  const update = vi.spyOn(currentCookbookConnection()!.adapter, "updateText");
  await toggleShopping([{ id: "line:1", content: "*1* aubergine, diced" }, { id: "line:4", content: "*1* aubergine, sliced" }], true);
  expect(await readText("Shopping.md")).toBe("## Pie\n- [x] *1* aubergine, diced\n\n## Soup\n- [x] *1* aubergine, sliced\n");
  expect(update).toHaveBeenCalledTimes(1);
  update.mockClear();
  await toggleShopping([{ id: "line:1", content: "*1* aubergine, diced" }, { id: "line:4", content: "*1* aubergine, sliced" }], false);
  expect(await readText("Shopping.md")).not.toContain("[x]");
  expect(update).toHaveBeenCalledTimes(1);
});

it("keeps aisle memory across builds resets and live store projections", async () => {
  await selectCookbook("dish.md", "# Dish\n\n---\n\n- *1* aubergine, sliced\n\n---\n\nCook.\n");
  await applyShoppingPlan(['dish.md']);
  const { updateShoppingAisle, resetShoppingList } = await import('./actions');
  const { getCookbookSnapshot } = await import('./store');
  const update = vi.spyOn(currentCookbookConnection()!.adapter, 'updateText');
  const before = await readText('Shopping.md');
  await updateShoppingAisle('*1* aubergine, sliced', 'Fruit & vegetables');
  expect(await readText('Aisles.md')).toBe('## Fruit & vegetables\n- aubergine\n');
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0][0]).toBe('Aisles.md');
  expect(await readText('Shopping.md')).toBe(before);
  expect(getCookbookSnapshot().shopping.items[0].labels).toEqual(['Fruit & vegetables']);
  await applyShoppingPlan([]);
  await resetShoppingList();
  await applyShoppingPlan(['dish.md']);
  expect(getCookbookSnapshot().shopping.items[0].labels).toEqual(['Fruit & vegetables']);
  await updateShoppingAisle('*1* aubergine, sliced', 'Chilled');
  expect(getCookbookSnapshot().shopping.items[0].labels).toEqual(['Chilled']);
  await updateShoppingAisle('*1* aubergine, sliced', '');
  expect(getCookbookSnapshot().shopping.items[0].labels).toEqual([]);
  expect(getCookbookSnapshot().recipes.map(recipe => recipe.path)).toEqual(['dish.md']);
});
