import { afterEach, describe, expect, it, vi } from "vitest";
import { openKitchen, type KitchenConnection } from "../host-client/kitchen-storage";
import { readText } from "../host-client/browser-storage";
import { parsePlan, parseRecipe } from "../core";
import { writeKitchenText } from "./doc";
import { currentKitchenConnection, setCurrentKitchenConnection } from "./current";
import { applyShoppingPlan, deleteRecipe, saveRecipe, updatePlanRecipe } from "./actions";

const connections: KitchenConnection[] = [];

async function selectKitchen(path: string, text: string): Promise<void> {
  const connection = await openKitchen({
    id: `abcdefghijklmnopqrstuvwxyz${connections.length}`,
    relayUrl: null,
    persist: false,
  });
  writeKitchenText(connection.doc, path, text);
  connections.push(connection);
  setCurrentKitchenConnection(connection);
}

async function selectShoppingKitchen(shopping: string) {
  await selectKitchen("a/first.md", "---\ntitle: Same\n---\n## Ingredients\n- first only");
  const connection = currentKitchenConnection()!;
  writeKitchenText(connection.doc, "z/second.md", "---\ntitle: Same\n---\n## Ingredients\n- second only");
  writeKitchenText(connection.doc, "malformed.md", "# Malformed");
  writeKitchenText(connection.doc, "Shopping.md", shopping);
  return vi.spyOn(connection.adapter, "updateText");
}

afterEach(async () => {
  vi.restoreAllMocks();
  setCurrentKitchenConnection(null);
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
});

describe("recipe actions", () => {
  it("merges a stale editor draft with the current kitchen text", async () => {
    const base = "first: base\nsecond: base\n";
    await selectKitchen("recipes/soup.md", "first: base\nsecond: remote\n");

    const result = await saveRecipe("recipes/soup.md", base, "first: local\nsecond: base\n");

    expect(result).toEqual({ text: "first: local\nsecond: remote\n", conflicts: 0 });
    await expect(readText("recipes/soup.md")).resolves.toBe(result.text);
  });

  it("removes a recipe through the current kitchen authority", async () => {
    await selectKitchen("recipes/soup.md", "# Soup\n");
    await deleteRecipe("recipes/soup.md");
    await expect(readText("recipes/soup.md")).rejects.toThrow("File not found");
  });

  it("applies concurrent recipe planning changes to live text", async () => {
    await selectKitchen("Plan.md", "## Marked\n");
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
    const updateText = await selectShoppingKitchen(
      "# Handwritten\r\nKeep this exactly.\r\n\r\n## Same\r\n- [x] SECOND ONLY\r\nOld owned bytes\r\n\r\n## Manual\r\n- [ ] note\r\n",
    );

    await applyShoppingPlan(["z/second.md", "a/first.md", "z/second.md"]);

    expect(updateText).toHaveBeenCalledTimes(1);
    expect(updateText.mock.calls[0]?.[0]).toBe("Shopping.md");
    await expect(readText("Shopping.md")).resolves.toBe(
      "# Handwritten\r\nKeep this exactly.\r\n\r\n## Manual\r\n- [ ] note\r\n\n## Same\n- [ ] first only\n\n## Same\n- [x] second only\n",
    );
  });

  it("cleans recipe sections with one write for zero selections", async () => {
    const updateText = await selectShoppingKitchen("# Handwritten\r\nKeep.\r\n\r\n## Same\r\n- [ ] stale\r\n\r\n## Manual\r\n- [x] exact\r\n");

    await applyShoppingPlan([]);

    expect(updateText).toHaveBeenCalledTimes(1);
    await expect(readText("Shopping.md")).resolves.toBe("# Handwritten\r\nKeep.\r\n\r\n## Manual\r\n- [x] exact\r\n");
  });

  it("fails closed without writing for every missing or malformed path", async () => {
    const before = "## Manual\n- [x] untouched\n";
    const updateText = await selectShoppingKitchen(before);

    await expect(applyShoppingPlan(["missing/z.md", "a/first.md", "malformed.md", "missing/z.md"]))
      .rejects.toThrow("Missing scheduled recipe files: malformed.md, missing/z.md");
    expect(updateText).not.toHaveBeenCalled();
    await expect(readText("Shopping.md")).resolves.toBe(before);
  });
});
