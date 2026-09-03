import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyTextDiff,
  deleteKitchenPath,
  hasKitchenDirectory,
  isKitchenId,
  kitchenIdFromUrl,
  kitchenLink,
  listKitchenPaths,
  newKitchenId,
  observeKitchen,
  readKitchenBytes,
  readKitchenText,
  withKitchenHash,
  writeKitchenBytes,
  writeKitchenText,
} from "./doc";

function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

describe("kitchen document", () => {
  it("stores text files as Y.Text and other files as bytes", () => {
    const doc = new Y.Doc();
    writeKitchenText(doc, "Shopping.md", "## Soup\n- [ ] onion\n");
    writeKitchenBytes(doc, "images/cover.webp", new Uint8Array([1, 2, 3]));
    expect(readKitchenText(doc, "Shopping.md")).toBe("## Soup\n- [ ] onion\n");
    expect(readKitchenBytes(doc, "images/cover.webp")).toEqual(new Uint8Array([1, 2, 3]));
    expect(listKitchenPaths(doc)).toEqual(["images/cover.webp", "Shopping.md"]);
    expect(hasKitchenDirectory(doc, "images")).toBe(true);
    expect(hasKitchenDirectory(doc, "recipes")).toBe(false);
  });

  it("applies the smallest edit so concurrent line edits merge", () => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    writeKitchenText(left, "Shopping.md", "- [ ] milk\n- [ ] eggs\n");
    sync(left, right);
    writeKitchenText(left, "Shopping.md", "- [x] milk\n- [ ] eggs\n");
    writeKitchenText(right, "Shopping.md", "- [ ] milk\n- [x] eggs\n");
    sync(left, right);
    sync(right, left);
    expect(readKitchenText(left, "Shopping.md")).toBe("- [x] milk\n- [x] eggs\n");
    expect(readKitchenText(right, "Shopping.md")).toBe(readKitchenText(left, "Shopping.md"));
  });

  it("keeps three independent concurrent ticks on their own items", () => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    const base = "- [ ] milk\n- [ ] eggs\n- [ ] bread\n";
    writeKitchenText(left, "Shopping.md", base);
    sync(left, right);
    writeKitchenText(left, "Shopping.md", "- [x] milk\n- [ ] eggs\n- [x] bread\n");
    writeKitchenText(right, "Shopping.md", "- [ ] milk\n- [x] eggs\n- [ ] bread\n");
    sync(left, right);
    sync(right, left);
    const expected = "- [x] milk\n- [x] eggs\n- [x] bread\n";
    expect(readKitchenText(left, "Shopping.md")).toBe(expected);
    expect(readKitchenText(right, "Shopping.md")).toBe(expected);
  });

  it("keeps a concurrent prepend and append", () => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    writeKitchenText(left, "Plan.md", "middle\n");
    sync(left, right);
    writeKitchenText(left, "Plan.md", "middle\nafter\n");
    writeKitchenText(right, "Plan.md", "before\nmiddle\n");
    sync(left, right);
    sync(right, left);
    expect(readKitchenText(left, "Plan.md")).toBe("before\nmiddle\nafter\n");
    expect(readKitchenText(right, "Plan.md")).toBe("before\nmiddle\nafter\n");
  });

  it("uses one small character hunk for a single changed line", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "abcdef");
    const deltas: unknown[] = [];
    text.observe((event) => deltas.push(event.delta));
    doc.transact(() => applyTextDiff(text, "abXYef"));
    expect(text.toString()).toBe("abXYef");
    expect(deltas).toEqual([[{ retain: 2 }, { delete: 2 }, { insert: "XY" }]]);
  });

  it("keeps both sides when two devices create the same file at once", () => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    writeKitchenText(left, "Shopping.md", "## Other\n- [ ] milk\n");
    writeKitchenText(right, "Shopping.md", "## Other\n- [ ] eggs\n");
    sync(left, right);
    sync(right, left);
    const merged = readKitchenText(left, "Shopping.md") ?? "";
    expect(merged).toBe(readKitchenText(right, "Shopping.md"));
    expect(merged).toContain("- [ ] milk");
    expect(merged).toContain("- [ ] eggs");
    expect(listKitchenPaths(left)).toEqual(["Shopping.md"]);
  });

  it("reports changed paths for map and text edits with their origin", () => {
    const doc = new Y.Doc();
    const seen: Array<[string[], unknown]> = [];
    const stop = observeKitchen(doc, (paths, origin) => seen.push([[...paths].sort(), origin]));
    writeKitchenText(doc, "Plan.md", "## Marked\n", "me");
    writeKitchenBytes(doc, "images/a.webp", new Uint8Array([1]), "me");
    writeKitchenText(doc, "Plan.md", "## Marked\n- [[x]]\n", "remote");
    deleteKitchenPath(doc, "Plan.md", false, "me");
    stop();
    writeKitchenText(doc, "ignored.md", "x");
    expect(seen).toEqual([
      [["Plan.md"], "me"],
      [["images/a.webp"], "me"],
      [["Plan.md"], "remote"],
      [["Plan.md"], "me"],
    ]);
  });

  it("diffs around the changed span", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "abcdef");
    applyTextDiff(text, "abXYef");
    expect(text.toString()).toBe("abXYef");
    applyTextDiff(text, "");
    expect(text.toString()).toBe("");
    applyTextDiff(text, "new");
    expect(text.toString()).toBe("new");
  });

  it("deletes files and directories", () => {
    const doc = new Y.Doc();
    writeKitchenText(doc, "recipes/a.md", "# A");
    writeKitchenText(doc, "recipes/b.md", "# B");
    expect(() => deleteKitchenPath(doc, "recipes")).toThrow(/not empty/);
    expect(deleteKitchenPath(doc, "recipes", true).sort()).toEqual(["recipes/a.md", "recipes/b.md"]);
    expect(listKitchenPaths(doc)).toEqual([]);
    expect(() => deleteKitchenPath(doc, "missing.md")).toThrow(/not found/);
  });

  it("makes unguessable ids that travel in the URL fragment", () => {
    const id = newKitchenId();
    expect(isKitchenId(id)).toBe(true);
    expect(newKitchenId()).not.toBe(id);
    expect(kitchenIdFromUrl(kitchenLink("https://enplace.app", id, "/shopping"))).toBe(id);
    expect(kitchenIdFromUrl("https://enplace.app/?k=nope")).toBeNull();
    expect(withKitchenHash("/planner?view=week", id)).toBe(`/planner?view=week#k=${id}`);
  });
});
