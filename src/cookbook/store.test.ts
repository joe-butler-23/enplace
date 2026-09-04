import { afterEach, describe, expect, it, vi } from "vitest";
import { updateText } from "../host-client/browser-storage";
import { openCookbook, type CookbookConnection } from "../host-client/cookbook-storage";
import { deleteCookbookPath, readCookbookText, writeCookbookBytes, writeCookbookText } from "./doc";
import { setCurrentCookbookConnection } from "./current";
import { getCookbookSnapshot, subscribeCookbook, type CookbookSnapshot } from "./store";

type CatalogRevisionAbsent = "catalogRevision" extends keyof CookbookSnapshot ? never : true;
const catalogRevisionAbsent: CatalogRevisionAbsent = true;
let connection: CookbookConnection | null = null;
afterEach(async () => {
  setCurrentCookbookConnection(null);
  await connection?.close();
  connection = null;
  vi.restoreAllMocks();
});

const recipe = (title: string, ingredient = "onion"): string => `# ${title}\n\n## Ingredients\n- ${ingredient}\n`;
async function open(files: Record<string, string | Uint8Array>): Promise<CookbookConnection> {
  connection = await openCookbook({ id: "abcdefghijklmnopqrstuvwxyz", relayUrl: null, persist: false });
  connection.doc.transact(() => {
    for (const [path, content] of Object.entries(files)) {
      if (typeof content === "string") writeCookbookText(connection!.doc, path, content);
      else writeCookbookBytes(connection!.doc, path, content);
    }
  });
  setCurrentCookbookConnection(connection);
  return connection;
}

const slices = ["recipes", "plan", "shopping", "files", "texts", "imageUrls"] as const;
const operations: Array<{
  name: string;
  mutate: (doc: CookbookConnection["doc"]) => void;
  same: Record<(typeof slices)[number], boolean>;
  assertValue: (snapshot: CookbookSnapshot) => void;
}> = [
  { name: "recipe edit", mutate: (doc) => writeCookbookText(doc, "a.md", recipe("A2", "garlic")),
    same: { recipes: false, plan: true, shopping: true, files: true, texts: false, imageUrls: true },
    assertValue: (value) => expect([value.recipes, value.texts.get("a.md")]).toEqual([[
      { path: "a.md", title: "A2", ingredients: ["garlic"], cover: null, added: null, tags: [], link: "a" },
    ], recipe("A2", "garlic")]) },
  { name: "Plan edit", mutate: (doc) => writeCookbookText(doc, "Plan.md", "## Marked\n- [[a]]\n"),
    same: { recipes: true, plan: false, shopping: true, files: true, texts: false, imageUrls: true },
    assertValue: (value) => expect([value.plan, value.texts.get("Plan.md")]).toEqual([
      { marked: ["a"], days: new Map(), notes: new Map() }, "## Marked\n- [[a]]\n",
    ]) },
  { name: "Shopping edit", mutate: (doc) => writeCookbookText(doc, "Shopping.md", "- [x] milk\n"),
    same: { recipes: true, plan: true, shopping: false, files: true, texts: false, imageUrls: true },
    assertValue: (value) => expect([value.shopping.items, value.texts.get("Shopping.md")]).toEqual([[
      { id: "line:0", content: "milk", labels: [], sources: [], checked: true },
    ], "- [x] milk\n"]) },
  { name: "file add", mutate: (doc) => writeCookbookBytes(doc, "notes.bin", new Uint8Array([1])),
    same: { recipes: true, plan: true, shopping: true, files: false, texts: true, imageUrls: true },
    assertValue: (value) => expect(value.files.map(({ path }) => path))
      .toEqual(["a.md", "notes.bin", "Plan.md", "Shopping.md"]) },
  { name: "image add", mutate: (doc) => writeCookbookBytes(doc, "cover.webp", new Uint8Array([1])),
    same: { recipes: true, plan: true, shopping: true, files: false, texts: true, imageUrls: false },
    assertValue: (value) => expect([value.files.map(({ path }) => path), [...value.imageUrls]]).toEqual([
      ["a.md", "cover.webp", "Plan.md", "Shopping.md"], [["cover.webp", "blob:cover"]],
    ]) },
];

describe("cookbook app store", () => {
  it("path-orders reverse recipe insertion and immutably repairs invalidated or deleted collisions", async () => {
    const opened = await open({});
    writeCookbookText(opened.doc, "b/FOO.MD", recipe("Shared", "pear"));
    writeCookbookText(opened.doc, "a/foo.md", recipe("Shared", "apple"));
    const firstCollision = getCookbookSnapshot().recipes[0];
    expect(getCookbookSnapshot().recipes.map(({ path, link }) => [path, link])).toEqual([
      ["a/foo.md", "a/foo"], ["b/FOO.MD", "b/FOO"],
    ]);
    writeCookbookText(opened.doc, "b/FOO.MD", "# invalid\n");
    expect(getCookbookSnapshot().recipes.map(({ path, link }) => [path, link])).toEqual([["a/foo.md", "foo"]]);
    expect(firstCollision.link).toBe("a/foo");

    writeCookbookText(opened.doc, "b/FOO.MD", recipe("Shared", "pear"));
    const secondCollision = getCookbookSnapshot().recipes[0];
    deleteCookbookPath(opened.doc, "b/FOO.MD");
    expect(getCookbookSnapshot().recipes.map(({ path, link }) => [path, link])).toEqual([["a/foo.md", "foo"]]);
    expect(secondCollision.link).toBe("a/foo");
  });

  it.each(operations)("publishes one complete $name and preserves every unaffected slice", async (operation) => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cover");
    const opened = await open({ "a.md": recipe("A"), "Plan.md": "## Marked\n", "Shopping.md": "- [ ] milk\n" });
    const before = getCookbookSnapshot();
    const changed = vi.fn();
    const stop = subscribeCookbook(changed);
    operation.mutate(opened.doc);
    const after = getCookbookSnapshot();

    expect(changed).toHaveBeenCalledOnce();
    expect(after.revision).toBe(before.revision + 1);
    operation.assertValue(after);
    for (const slice of slices) expect(after[slice] === before[slice]).toBe(operation.same[slice]);

    changed.mockClear();
    opened.doc.transact(() => {
      writeCookbookBytes(opened.doc, "temporary.bin", new Uint8Array([1]));
      deleteCookbookPath(opened.doc, "temporary.bin");
    });
    expect(changed).not.toHaveBeenCalled();
    expect(getCookbookSnapshot()).toBe(after);
    stop();
  });

  it("gives bootstrap and live mutation routes the same literal complete projection", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:bootstrap").mockReturnValueOnce("blob:live");
    const final = {
      "a/foo.md": recipe("Shared", "apple"), "b/FOO.MD": recipe("Shared", "pear"),
      "Plan.md": "## Marked\n- [[a/foo]]\n\n## Ingredients\n- planner note\n",
      "Shopping.md": "## Shared\n- [x] apple\n", "dish.webp": new Uint8Array([2]),
    };
    const results: CookbookSnapshot[] = [];
    for (const route of ["bootstrap", "live"] as const) {
      if (route === "bootstrap") await open(final);
      else {
        const opened = await open({ "b/FOO.MD": "# draft\n", "gone.md": recipe("Gone") });
        writeCookbookText(opened.doc, "a/foo.md", final["a/foo.md"]);
        opened.doc.transact(() => {
          writeCookbookText(opened.doc, "b/FOO.MD", final["b/FOO.MD"]);
          writeCookbookText(opened.doc, "Plan.md", final["Plan.md"]);
          writeCookbookText(opened.doc, "Shopping.md", final["Shopping.md"]);
          writeCookbookBytes(opened.doc, "dish.webp", final["dish.webp"]);
          deleteCookbookPath(opened.doc, "gone.md");
        });
      }
      const value = getCookbookSnapshot();
      expect(value.recipes).toEqual([
        { path: "a/foo.md", title: "Shared", ingredients: ["apple"], cover: null, added: null, tags: [], link: "a/foo" },
        { path: "b/FOO.MD", title: "Shared", ingredients: ["pear"], cover: null, added: null, tags: [], link: "b/FOO" },
      ]);
      expect(value.plan).toEqual({ marked: ["a/foo"], days: new Map(), notes: new Map() });
      expect(value.shopping.items).toEqual([
        { id: "line:1", content: "apple", labels: ["Shared"], sources: ["Shared"], checked: true },
      ]);
      expect(value.files.map(({ path }) => path)).toEqual(["a/foo.md", "b/FOO.MD", "dish.webp", "Plan.md", "Shopping.md"]);
      expect(value.texts.size).toBe(4);
      expect(value.texts.get("a/foo.md")).toBe(final["a/foo.md"]);
      expect(value.texts.get("b/FOO.MD")).toBe(final["b/FOO.MD"]);
      expect(value.texts.get("Plan.md")).toBe(final["Plan.md"]);
      expect(value.texts.get("Shopping.md")).toBe(final["Shopping.md"]);
      expect([...value.imageUrls]).toEqual([["dish.webp", `blob:${route}`]]);
      results.push(value);
      setCurrentCookbookConnection(null);
      await connection!.close();
      connection = null;
    }
    expect(results[1].recipes).toEqual(results[0].recipes);
    expect(results[1].plan).toEqual(results[0].plan);
    expect(results[1].shopping).toEqual(results[0].shopping);
    expect(results[1].files).toEqual(results[0].files);
  });

  it("reuses one image URL while exactly revoking another on replace, delete, and clear", async () => {
    const create = vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:a1").mockReturnValueOnce("blob:b1").mockReturnValueOnce("blob:a2");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const opened = await open({ "a.md": recipe("A"), "a.webp": new Uint8Array([1]), "b.webp": new Uint8Array([2]) });
    const images = getCookbookSnapshot().imageUrls;
    writeCookbookText(opened.doc, "a.md", recipe("A2"));
    expect(getCookbookSnapshot().imageUrls).toBe(images);
    expect(create).toHaveBeenCalledTimes(2);
    expect(revoke).not.toHaveBeenCalled();
    writeCookbookBytes(opened.doc, "a.webp", new Uint8Array([3]));
    expect([...getCookbookSnapshot().imageUrls]).toEqual([["b.webp", "blob:b1"], ["a.webp", "blob:a2"]]);
    expect(revoke.mock.calls).toEqual([["blob:a1"]]);
    deleteCookbookPath(opened.doc, "a.webp");
    expect(revoke.mock.calls).toEqual([["blob:a1"], ["blob:a2"]]);
    setCurrentCookbookConnection(null);
    expect(revoke.mock.calls).toEqual([["blob:a1"], ["blob:a2"], ["blob:b1"]]);
  });

  it("clears and switches authority without a catalogue revision", async () => {
    expect(catalogRevisionAbsent).toBe(true);
    await open({ "Shopping.md": "- [ ] first\n" });
    const first = connection!;
    const changed = vi.fn();
    const stop = subscribeCookbook(changed);
    setCurrentCookbookConnection(null);
    expect(changed).toHaveBeenCalledOnce();
    expect(getCookbookSnapshot()).toEqual({
      recipes: [], plan: { marked: [], days: new Map(), notes: new Map() }, shopping: { items: [] },
      files: [], texts: new Map(), imageUrls: new Map(), revision: 0,
    });
    expect(getCookbookSnapshot()).not.toHaveProperty("catalogRevision");
    expect(() => updateText("Shopping.md", () => "- [ ] forbidden\n")).toThrow("No cookbook connection is active");

    changed.mockClear();
    connection = await openCookbook({ id: "secondabcdefghijklmnopqrst", relayUrl: null, persist: false });
    writeCookbookText(connection.doc, "Shopping.md", "- [ ] second\n");
    setCurrentCookbookConnection(connection);
    expect(changed).toHaveBeenCalledOnce();
    expect(getCookbookSnapshot()).toEqual({
      recipes: [], plan: { marked: [], days: new Map(), notes: new Map() },
      shopping: { items: [{ id: "line:0", content: "second", labels: [], sources: [], checked: false }] },
      files: [{ path: "Shopping.md" }], texts: new Map([["Shopping.md", "- [ ] second\n"]]),
      imageUrls: new Map(), revision: 1,
    });
    stop();
    await updateText("Shopping.md", (text) => `${text}- [ ] added\n`);
    expect(getCookbookSnapshot().shopping.items.map(({ content }) => content)).toEqual(["second", "added"]);
    expect(readCookbookText(first.doc, "Shopping.md")).toBe("- [ ] first\n");
    expect(readCookbookText(connection.doc, "Shopping.md")).toBe("- [ ] second\n- [ ] added\n");
    await first.close();
  });
});
