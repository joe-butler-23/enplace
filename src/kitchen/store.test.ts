import { afterEach, describe, expect, it, vi } from "vitest";
import { openKitchen, type KitchenConnection } from "../host-client/kitchen-storage";
import { writeKitchenBytes, writeKitchenText } from "./doc";
import { setCurrentKitchenConnection } from "./current";
import { getKitchenSnapshot, subscribeKitchen } from "./store";

let connection: KitchenConnection | null = null;
afterEach(async () => {
  setCurrentKitchenConnection(null);
  await connection?.close(); connection = null;
});

const recipe = (title: string, ingredient = "onion"): string => `# ${title}\n\n## Ingredients\n- ${ingredient}\n`;

async function open(files: Record<string, string>): Promise<KitchenConnection> {
  connection = await openKitchen({ id: "abcdefghijklmnopqrstuvwxyz", relayUrl: null, persist: false });
  connection.doc.transact(() => {
    for (const [path, text] of Object.entries(files)) writeKitchenText(connection!.doc, path, text);
  });
  setCurrentKitchenConnection(connection);
  return connection;
}

describe("kitchen app store", () => {
  it("publishes parsed recipes, plan, shopping, paths, and live text changes", async () => {
    await open({
      "soup.md": recipe("Soup"),
      "Plan.md": "## Marked\n- [[soup]]\n",
      "Shopping.md": "## Soup\n- [ ] onion\n",
    });
    const snapshot = getKitchenSnapshot();
    expect(snapshot.recipes.map((value) => value.title)).toEqual(["Soup"]);
    expect(snapshot.plan.marked).toEqual(["soup"]);
    expect(snapshot.shopping.items[0]).toMatchObject({ content: "onion", checked: false });
    expect(snapshot.files.map((file) => file.path)).toEqual(["Plan.md", "Shopping.md", "soup.md"]);
    expect(snapshot.texts.get("soup.md")).toContain("## Ingredients");
  });

  it("updates only changed slices and preserves unrelated recipe objects", async () => {
    const opened = await open({
      "recipes/a.md": recipe("A"),
      "recipes/b.md": recipe("B"),
      "Plan.md": "## Marked\n",
      "Shopping.md": "- [ ] milk\n",
    });
    const first = getKitchenSnapshot();
    const recipeB = first.recipes.find((value) => value.path === "recipes/b.md");
    const changed = vi.fn(); const stop = subscribeKitchen(changed);

    writeKitchenText(opened.doc, "Shopping.md", "- [x] milk\n");
    const shopping = getKitchenSnapshot();
    expect(changed).toHaveBeenCalledOnce();
    expect(shopping.shopping).not.toBe(first.shopping);
    expect(shopping.recipes).toBe(first.recipes);
    expect(shopping.plan).toBe(first.plan);
    expect(shopping.files).toBe(first.files);
    expect(shopping.imageUrls).toBe(first.imageUrls);
    expect(shopping.catalogRevision).toBe(first.catalogRevision);

    changed.mockClear();
    writeKitchenText(opened.doc, "recipes/a.md", recipe("A revised", "garlic"));
    const revised = getKitchenSnapshot();
    expect(changed).toHaveBeenCalledOnce();
    expect(revised.recipes).not.toBe(shopping.recipes);
    expect(revised.recipes.find((value) => value.path === "recipes/b.md")).toBe(recipeB);
    expect(revised.plan).toBe(shopping.plan);
    expect(revised.shopping).toBe(shopping.shopping);
    expect(revised.files).toBe(shopping.files);
    stop();
  });

  it("publishes one final snapshot for a multi-path Yjs transaction", async () => {
    const opened = await open({
      "recipes/a.md": recipe("A"),
      "Plan.md": "## Marked\n",
      "Shopping.md": "- [ ] milk\n",
    });
    const changed = vi.fn(); const stop = subscribeKitchen(changed);
    opened.doc.transact(() => {
      writeKitchenText(opened.doc, "recipes/a.md", recipe("A2"));
      writeKitchenText(opened.doc, "Plan.md", "## Marked\n- [[a]]\n");
      writeKitchenText(opened.doc, "Shopping.md", "- [x] milk\n");
    });
    stop();

    expect(changed).toHaveBeenCalledOnce();
    const snapshot = getKitchenSnapshot();
    expect(snapshot.recipes[0].title).toBe("A2");
    expect(snapshot.plan.marked).toEqual(["a"]);
    expect(snapshot.shopping.items[0].checked).toBe(true);
  });

  it("does not publish a path created and deleted within one transaction", async () => {
    const opened = await open({ "a.md": recipe("A") });
    const changed = vi.fn(); const stop = subscribeKitchen(changed);
    opened.doc.transact(() => {
      writeKitchenBytes(opened.doc, "temporary.webp", new Uint8Array([1]));
      opened.doc.getMap("files").delete("temporary.webp");
    });
    stop();
    expect(changed).not.toHaveBeenCalled();
  });

  it("repairs colliding recipe links without replacing unrelated recipes", async () => {
    const opened = await open({ "a/foo.md": recipe("A Foo"), "bar.md": recipe("Bar") });
    const first = getKitchenSnapshot();
    const bar = first.recipes.find((value) => value.path === "bar.md");
    expect(first.recipes.find((value) => value.path === "a/foo.md")?.link).toBe("foo");

    writeKitchenText(opened.doc, "b/foo.md", recipe("B Foo"));
    const collided = getKitchenSnapshot();
    expect(collided.recipes.find((value) => value.path === "a/foo.md")?.link).toBe("a/foo");
    expect(collided.recipes.find((value) => value.path === "b/foo.md")?.link).toBe("b/foo");
    expect(collided.recipes.find((value) => value.path === "bar.md")).toBe(bar);

    await opened.adapter.remove("b/foo.md");
    expect(getKitchenSnapshot().recipes.find((value) => value.path === "a/foo.md")?.link).toBe("foo");
  });
});
