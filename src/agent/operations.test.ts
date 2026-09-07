import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COOKING_OPERATIONS, cookingTextRevision, executeCookingOperation, type CookingOperationContext } from "./operations";
import { listCookbookPaths, readCookbookText, writeCookbookText } from "../cookbook/doc";
import { parsePlan, parseRecipe, parseShopping } from "../core";

const docs: Y.Doc[] = [];
const receipts = "enplace-agent-operation-receipts";
const recoveries = "enplace-agent-recipe-recoveries";
const soup = "# Soup\n\nSource: https://example.test/soup\n\n*cheap, vegetarian*\n\n---\n\n- *2* onions, diced\n- *1 tsp* salt\n\n---\n\n1. Simmer gently.\n";
const pie = "# Pie\n\n---\n\n- *1* onions, sliced\n- *100 g* flour\n\n---\n\n1. Bake.\n";
const plan = "## Marked\n- [[soup]]\n\n## 2026-09-07\n- [[soup]]\n- [[pie]]\n";
function context(files: Record<string, string> = {}): CookingOperationContext {
  const doc = new Y.Doc(); docs.push(doc);
  for (const [path, text] of Object.entries(files)) writeCookbookText(doc, path, text);
  return { doc,
    async mutate<T>(operation: () => T): Promise<T> { let result!: T; doc.transact(() => { result = operation(); }, "agent-test"); return result; } };
}
const run = (book: CookingOperationContext, name: string, args: Record<string, unknown> = {}) => executeCookingOperation(book, name, args);
async function revision(book: CookingOperationContext, path: string): Promise<string> { return cookingTextRevision(readCookbookText(book.doc, path) ?? ""); }
function clone(book: CookingOperationContext): CookingOperationContext {
  const copy = context(); Y.applyUpdate(copy.doc, Y.encodeStateAsUpdate(book.doc)); return copy;
}
function sync(one: CookingOperationContext, two: CookingOperationContext): void {
  const a = Y.encodeStateAsUpdate(one.doc), b = Y.encodeStateAsUpdate(two.doc);
  Y.applyUpdate(one.doc, b); Y.applyUpdate(two.doc, a);
}
afterEach(() => { for (const doc of docs.splice(0)) doc.destroy(); });

describe("agent operation contract", () => {
  it("exposes domain verbs and rejects arbitrary operations, unknown arguments and non-recipe paths", async () => {
    const book = context({ "Plan.md": plan, "soup.md": soup });
    expect(COOKING_OPERATIONS.every(item => item.inputSchema.additionalProperties === false)).toBe(true);
    await expect(run(book, "file.write", { path: "Plan.md", markdown: "bad" })).rejects.toMatchObject({ code: "unknown_operation" });
    await expect(run(book, "recipe.list", { command: "touch file" })).rejects.toMatchObject({ code: "invalid_arguments" });
    for (const path of ["../soup.md", "/tmp/soup.md", "Plan.md", "Shopping.md", "Aisles.md"]) {
      await expect(run(book, "recipe.get", { path })).rejects.toThrow();
    }
    expect(book.doc.getMap(receipts).size).toBe(0);
    expect(readCookbookText(book.doc, "Plan.md")).toBe(plan);
  });

  it("returns lightweight recipe summaries, full text on get, literal search and unresolved plan evidence", async () => {
    const book = context({ "recipes/soup.md": soup, "pie.md": pie, "bad.md": "# broken", "Plan.md": plan.replaceAll("[[soup]]", "[[recipes/soup]]") + "- [[missing]]\n" });
    const result = await run(book, "recipe.list");
    expect(result.invalidRecipes).toEqual(["bad.md"]);
    const rows = result.recipes as Record<string, unknown>[];
    expect(rows.find(row => row.path === "recipes/soup.md")).toMatchObject({ marked: true, scheduledDates: ["2026-09-07"], cover: false });
    expect(rows.every(row => !("ingredients" in row) && !("markdown" in row))).toBe(true);
    expect((await run(book, "recipe.search", { query: "simmer vegetarian" })).recipes).toHaveLength(1);
    expect(await run(book, "recipe.get", { path: "recipes/soup.md" })).toMatchObject({ markdown: soup, revision: await cookingTextRevision(soup) });
    expect((await run(book, "plan.read")).warnings).toEqual([expect.stringContaining("missing")]);
  });

  it("creates deterministically, replays after reconnect, and keeps receipts compact", async () => {
    const book = context();
    const input = { operationId: "create-soup-0001", markdown: soup };
    const created = await run(book, "recipe.create", input);
    expect(created.path).toMatch(/^soup-[a-f0-9]{24}\.md$/);
    expect(created.markdown).toContain("Source: https://example.test/soup");
    const reopened = clone(book);
    const replay = await run(reopened, "recipe.create", input);
    expect(replay).toMatchObject({ path: created.path, revision: created.revision, replayed: true, readOperation: "recipe.get" });
    expect(listCookbookPaths(reopened.doc)).toEqual([created.path]);
    const raw = reopened.doc.getMap<string>(receipts).get(input.operationId)!;
    expect(raw.length).toBeLessThan(500);
    expect(raw).not.toContain("Simmer");
    expect(raw).not.toContain("markdown");
    await expect(run(reopened, "recipe.create", { ...input, markdown: pie })).rejects.toMatchObject({ code: "operation_id_reused" });
    const second = await run(reopened, "recipe.create", { ...input, operationId: "create-soup-0002" });
    expect(second.path).not.toBe(created.path);
  });

  it("rejects invalid RecipeMD without recording a receipt or any file", async () => {
    const book = context();
    await expect(run(book, "recipe.create", { operationId: "bad-recipe-0001", markdown: "# Ingredients only" })).rejects.toMatchObject({ code: "invalid_recipe" });
    expect(listCookbookPaths(book.doc)).toEqual([]);
    expect(book.doc.getMap(receipts).size).toBe(0);
  });

  it("merges amendments against their base, preserves overlap as explicit conflicts, and never replays old text over a newer edit", async () => {
    const current = soup.replace("Simmer gently.", "Simmer for 20 minutes.");
    const book = context({ "soup.md": current });
    const request = { path: "soup.md", base: soup, markdown: soup.replace("*2* onions", "*3* onions"), operationId: "amend-soup-0001" };
    const changed = await run(book, "recipe.update", request);
    expect(changed).toMatchObject({ conflicts: 0, requiresResolution: false });
    expect(changed.markdown).toContain("*3* onions");
    expect(changed.markdown).toContain("Simmer for 20 minutes.");
    const later = (changed.markdown as string) + "\nServe warm.\n";
    writeCookbookText(book.doc, "soup.md", later);
    expect(await run(book, "recipe.update", request)).toMatchObject({ replayed: true });
    expect(readCookbookText(book.doc, "soup.md")).toBe(later);
    const conflict = await run(book, "recipe.update", { operationId: "amend-soup-0002", path: "soup.md", base: soup, markdown: soup.replace("Simmer gently.", "Boil hard.") });
    expect(conflict).toMatchObject({ conflicts: 1, requiresResolution: true });
    expect(conflict.markdown).toContain("Boil hard.");
    expect(conflict.markdown).toContain("Simmer for 20 minutes.");
  });

  it("guards recipe deletion, publishes recovery atomically, and restores without overwriting", async () => {
    const book = context({ "soup.md": soup, "Plan.md": plan });
    const expectedRevision = await revision(book, "soup.md");
    writeCookbookText(book.doc, "soup.md", soup + "\nExtra note.\n");
    await expect(run(book, "recipe.delete", { path: "soup.md", expectedRevision, operationId: "delete-soup-stale" })).rejects.toMatchObject({ code: "stale_revision" });
    const original = readCookbookText(book.doc, "soup.md")!;
    const remote = clone(book);
    const updates: Uint8Array[] = [];
    book.doc.on("update", update => updates.push(update));
    const deleted = await run(book, "recipe.delete", { path: "soup.md", expectedRevision: await revision(book, "soup.md"), operationId: "delete-soup-0001" });
    expect(updates).toHaveLength(1);
    Y.applyUpdate(remote.doc, updates[0]);
    expect(readCookbookText(remote.doc, "soup.md")).toBeNull();
    expect(remote.doc.getMap(receipts).has("delete-soup-0001")).toBe(true);
    expect(remote.doc.getMap(recoveries).has("delete-soup-0001")).toBe(true);
    expect(readCookbookText(book.doc, "Plan.md")).toBe(plan);
    expect((await run(book, "plan.read")).warnings).toContainEqual(expect.stringContaining("soup"));
    expect((await run(book, "recipe.recoveries")).recoveries).toHaveLength(1);
    await run(book, "recipe.restore", { recoveryId: deleted.recoveryId, operationId: "restore-soup-0001" });
    expect(readCookbookText(book.doc, "soup.md")).toBe(original);
    await expect(run(book, "recipe.restore", { recoveryId: deleted.recoveryId, operationId: "restore-soup-0002" })).rejects.toMatchObject({ code: "recipe_exists" });
  });

  it("cannot use a malformed recovery record as a generic Plan.md writer", async () => {
    const book = context();
    book.doc.getMap<string>(recoveries).set("forged-recovery", JSON.stringify({ path: "Plan.md", markdown: soup, revision: await cookingTextRevision(soup) }));
    await expect(run(book, "recipe.restore", { recoveryId: "forged-recovery", operationId: "restore-forged-1" })).rejects.toMatchObject({ code: "invalid_recipe_path" });
    expect(readCookbookText(book.doc, "Plan.md")).toBeNull();
  });
});

describe("recipe search", () => {
  it("filters complete case-insensitive tags, intersects query words, and limits after filtering without mutations", async () => {
    const book = context({
      "prose.md": pie.replace("# Pie", "# A vegetarian suggestion"),
      "non-vegetarian.md": soup.replace("# Soup", "# B meat soup").replace("cheap, vegetarian", "cheap, non-vegetarian"),
      "slow.md": soup.replace("# Soup", "# C slow soup").replace("cheap, vegetarian", "vegetarian, slow"),
      "soup.md": soup,
    });
    const before = Y.encodeStateAsUpdate(book.doc);
    const paths = async (args: Record<string, unknown>) => (await run(book, "recipe.search", args)).recipes as { path: string }[];
    expect((await paths({ tags: ["VeGeTaRiAn"] })).map(recipe => recipe.path)).toEqual(["slow.md", "soup.md"]);
    expect((await paths({ tags: ["VEGETARIAN", "CHEAP"], limit: 1 })).map(recipe => recipe.path)).toEqual(["soup.md"]);
    expect((await paths({ query: "simmer soup", tags: ["vegetarian", "cheap"] })).map(recipe => recipe.path)).toEqual(["soup.md"]);
    expect(await paths({ query: "bake", tags: ["vegetarian"] })).toEqual([]);
    expect(Y.encodeStateAsUpdate(book.doc)).toEqual(before);
  });

  it("returns optional ingredients from the shared parser while keeping default results lightweight", async () => {
    const markdown = soup.replace("- *2* onions, diced", "## Soup base\n\n- *2* onions, diced").replace("- *1 tsp* salt", "## Finish\n\n- *1 tsp* salt");
    const book = context({ "soup.md": markdown, "bad.md": "# Broken" });
    const lightweight = await run(book, "recipe.search", { tags: ["vegetarian"] });
    const detailed = await run(book, "recipe.search", { tags: ["vegetarian"], includeIngredients: true });
    const rows = detailed.recipes as Record<string, unknown>[];
    expect(rows).toEqual([{ ...(lightweight.recipes as Record<string, unknown>[])[0], ingredients: parseRecipe("soup.md", markdown)!.ingredients }]);
    expect(rows[0].ingredients).toEqual(["*2* onions, diced", "*1 tsp* salt"]);
    expect(rows[0]).not.toHaveProperty("markdown");
    expect((lightweight.recipes as Record<string, unknown>[])[0]).not.toHaveProperty("ingredients");
    expect(await run(book, "recipe.search", { tags: ["vegetarian"], includeIngredients: false })).toEqual(lightweight);
    expect(detailed.invalidRecipes).toEqual(["bad.md"]);
  });

  it("supports bounded browsing with omitted filters or an empty tag list", async () => {
    const book = context({ "soup.md": soup, "pie.md": pie });
    const listed = (await run(book, "recipe.list")).recipes as Record<string, unknown>[];
    expect((await run(book, "recipe.search", { limit: 1 })).recipes).toEqual(listed.slice(0, 1));
    expect(await run(book, "recipe.search", { tags: [], limit: 1 })).toEqual(await run(book, "recipe.search", { limit: 1 }));
  });

  it.each([
    { tags: "vegetarian" }, { tags: [1] }, { tags: [""] }, { tags: ["vegetarian", "vegetarian"] },
    { includeIngredients: "true" }, { query: "" }, { limit: 0 }, { limit: 1001 }, { command: "run this" },
  ])("rejects invalid arguments %j", async args => {
    await expect(run(context({ "soup.md": soup }), "recipe.search", args)).rejects.toMatchObject({ code: "invalid_arguments" });
  });
});

describe("plan and shopping operations", () => {
  it("adds, moves, removes, marks and annotates without losing another occurrence or full-path aliases", async () => {
    const book = context({ "recipes/soup.md": soup, "Plan.md": plan.replaceAll("[[soup]]", "[[recipes/soup]]") });
    const update = async (name: string, args: Record<string, unknown>, operationId: string) => run(book, name, { ...args, operationId, expectedRevision: await revision(book, "Plan.md") });
    await update("plan.add", { path: "recipes/soup.md", date: "2026-09-09" }, "plan-add-soup-1");
    await update("plan.move", { path: "recipes/soup.md", from: "2026-09-07", to: "2026-09-10" }, "plan-move-soup-1");
    await update("plan.remove", { path: "recipes/soup.md", date: "2026-09-09" }, "plan-remove-soup-1");
    await update("plan.mark", { path: "recipes/soup.md", marked: false }, "plan-unmark-soup-1");
    await update("plan.note", { date: "2026-09-10", note: "Dinner with a friend" }, "plan-note-soup-1");
    const parsed = parsePlan(readCookbookText(book.doc, "Plan.md")!);
    expect(parsed.days.get("2026-09-10")).toEqual(["soup"]);
    expect(parsed.days.get("2026-09-07")).toEqual(["pie"]);
    expect(parsed.days.has("2026-09-09")).toBe(false);
    expect(parsed.marked).toEqual([]);
    expect(parsed.notes.get("2026-09-10")).toBe("Dinner with a friend");
    await expect(update("plan.add", { path: "recipes/soup.md", date: "2026-02-30" }, "plan-invalid-date")).rejects.toMatchObject({ code: "invalid_date" });
    await expect(update("plan.move", { path: "recipes/soup.md", from: "2026-09-08", to: "2026-09-09" }, "plan-missing-meal")).rejects.toMatchObject({ code: "meal_missing" });
  });

  it("builds the real week's shopping, preserves manual and checked items, and exposes every grouped member", async () => {
    const before = "Remember reusable bags.\n\n## Soup\n- [x] *2* onions, diced\n\n## Other\n- [ ] washing-up liquid\n";
    const book = context({ "soup.md": soup, "pie.md": pie, "Plan.md": plan, "Shopping.md": before });
    const built = await run(book, "shopping.build", { operationId: "build-week-0001", week: "2026-09-09", expectedRevision: await revision(book, "Shopping.md"), planRevision: await revision(book, "Plan.md") });
    const markdown = built.markdown as string;
    expect(markdown).toContain("Remember reusable bags.");
    expect(markdown).toContain("- [ ] washing-up liquid");
    expect(markdown).toContain("- [x] *2* onions, diced");
    const group = (built.groups as { noun: string; memberIds: string[] }[]).find(group => group.noun === "onions")!;
    expect(group.memberIds).toHaveLength(2);
    const checked = await run(book, "shopping.check", { operationId: "check-onions-001", itemIds: group.memberIds, expectedRevision: built.revision });
    expect(parseShopping(checked.markdown as string).filter(item => item.text.includes("onions")).every(item => item.checked)).toBe(true);
    const unchecked = await run(book, "shopping.uncheck", { operationId: "uncheck-onions-01", itemIds: group.memberIds, expectedRevision: checked.revision });
    expect(parseShopping(unchecked.markdown as string).filter(item => item.text.includes("onions")).every(item => !item.checked)).toBe(true);
    expect(book.doc.getMap<string>(receipts).get("check-onions-001")!.length).toBeLessThan(400);
  });

  it("rejects stale shopping selections and mutations received while preparation awaits the transaction gate", async () => {
    const before = "## Other\n- [ ] apples\n- [ ] pears\n";
    const book = context({ "Shopping.md": before });
    const initial = await run(book, "shopping.read");
    writeCookbookText(book.doc, "Shopping.md", "## Other\n- [ ] bananas\n" + before);
    await expect(run(book, "shopping.check", { operationId: "check-stale-item", itemIds: ["line:1"], expectedRevision: initial.revision })).rejects.toMatchObject({ code: "stale_revision" });
    expect(readCookbookText(book.doc, "Shopping.md")).not.toContain("[x]");
    const current = await run(book, "shopping.read");
    const mutate = book.mutate;
    book.mutate = async operation => {
      writeCookbookText(book.doc, "Shopping.md", "## Other\n- [ ] a partner's new item\n");
      return mutate(operation);
    };
    await expect(run(book, "shopping.check", { operationId: "check-during-await", itemIds: ["line:1"], expectedRevision: current.revision })).rejects.toMatchObject({ code: "stale_revision" });
    expect(readCookbookText(book.doc, "Shopping.md")).toBe("## Other\n- [ ] a partner's new item\n");
    expect(book.doc.getMap(receipts).size).toBe(0);
  });

  it("retries a manual append after reconnect without duplicating it, then edits and removes exact rows", async () => {
    const book = context({ "Shopping.md": "## Other\n- [ ] apples\n" });
    const request = { operationId: "manual-append-01", content: "soap" };
    const appended = await run(book, "shopping.add", request);
    const reopened = clone(book);
    const again = await run(reopened, "shopping.add", request);
    expect(parseShopping(readCookbookText(reopened.doc, "Shopping.md")!).filter(item => item.text === "soap")).toHaveLength(1);
    expect(again).toMatchObject({ replayed: true, readOperation: "shopping.read" });
    const soap = (appended.items as { id: string; content: string }[]).find(item => item.content === "soap")!;
    const edited = await run(reopened, "shopping.edit", { operationId: "manual-edit-0001", itemId: soap.id, content: "washing-up liquid", expectedRevision: appended.revision });
    const removed = await run(reopened, "shopping.remove", { operationId: "manual-remove-01", itemIds: [soap.id], expectedRevision: edited.revision });
    expect(parseShopping(removed.markdown as string).map(item => item.text)).toEqual(["apples"]);
    await expect(run(reopened, "shopping.check", { operationId: "ambiguous-ids-01", itemIds: ["line:1", "line:1"], expectedRevision: removed.revision })).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("keeps aisle memory and notes when resetting every checked and unchecked item", async () => {
    const book = context({ "Shopping.md": "Remember bags.\n\n## Other\n- [ ] apples\n- [x] soap\n" });
    await run(book, "aisles.set", { operationId: "aisle-apples-01", noun: "apples", aisle: "Fruit & vegetables", expectedRevision: await revision(book, "Aisles.md") });
    expect((await run(book, "shopping.read")).items).toContainEqual(expect.objectContaining({ noun: "apples", aisle: "Fruit & vegetables" }));
    const reset = await run(book, "shopping.reset", { operationId: "reset-shopping-01", expectedRevision: await revision(book, "Shopping.md") });
    expect(reset.items).toEqual([]);
    expect(reset.markdown).toContain("Remember bags.");
    expect((await run(book, "aisles.read")).assignments).toEqual({ apples: "Fruit & vegetables" });
    await run(book, "aisles.set", { operationId: "aisle-clear-001", noun: "apples", aisle: "", expectedRevision: await revision(book, "Aisles.md") });
    expect((await run(book, "aisles.read")).assignments).toEqual({});
  });

  it("rejects builds from missing or ambiguous plan references without replacing the shopping list", async () => {
    const book = context({ "one/soup.md": soup, "two/soup.md": soup, "Plan.md": "## 2026-09-07\n- [[soup]]\n", "Shopping.md": "Keep me.\n" });
    await expect(run(book, "shopping.build", { operationId: "build-ambiguous", week: "2026-09-07", expectedRevision: await revision(book, "Shopping.md"), planRevision: await revision(book, "Plan.md") })).rejects.toMatchObject({ code: "recipe_missing" });
    expect(readCookbookText(book.doc, "Shopping.md")).toBe("Keep me.\n");
    expect(book.doc.getMap(receipts).size).toBe(0);
  });

  it("preserves independent disconnected plan additions after Yjs convergence", async () => {
    const one = context({ "soup.md": soup, "pie.md": pie, "Plan.md": "## Marked\n" });
    const two = clone(one), expectedRevision = await revision(one, "Plan.md");
    await run(one, "plan.add", { operationId: "offline-plan-one", path: "soup.md", date: "2026-09-07", expectedRevision });
    await run(two, "plan.add", { operationId: "offline-plan-two", path: "pie.md", date: "2026-09-07", expectedRevision });
    sync(one, two);
    expect(readCookbookText(one.doc, "Plan.md")).toBe(readCookbookText(two.doc, "Plan.md"));
    expect(parsePlan(readCookbookText(one.doc, "Plan.md")!).days.get("2026-09-07")?.sort()).toEqual(["pie", "soup"]);
    expect(one.doc.getMap(receipts).size).toBe(2);
  });

  it("documents that a retry token is not distributed CAS between disconnected writers", async () => {
    const one = context({ "Shopping.md": "## Other\n" }), two = clone(one);
    const request = { operationId: "same-offline-token", content: "soap" };
    await run(one, "shopping.add", request);
    await run(two, "shopping.add", request);
    sync(one, two);
    expect(parseShopping(readCookbookText(one.doc, "Shopping.md")!).filter(item => item.text === "soap")).toHaveLength(2);
    expect(await run(one, "shopping.add", request)).toMatchObject({ replayed: true });
  });

  it("cannot write content or receipt when connection write health rejects the operation", async () => {
    const book = context({ "Shopping.md": "Keep me.\n" });
    book.mutate = async () => { throw new Error("Cookbook changes cannot be saved right now"); };
    await expect(run(book, "shopping.add", { operationId: "unhealthy-write", content: "soap" })).rejects.toThrow("cannot be saved");
    expect(readCookbookText(book.doc, "Shopping.md")).toBe("Keep me.\n");
    expect(book.doc.getMap(receipts).size).toBe(0);
  });
});
