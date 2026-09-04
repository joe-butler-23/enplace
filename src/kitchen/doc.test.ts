import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyTextDiff,
  deleteKitchenPath,
  hasKitchenDirectory,
  isKitchenId,
  kitchenFiles,
  kitchenIdFromUrl,
  kitchenLink,
  listKitchenPaths,
  newKitchenId,
  normalizeKitchenPath,
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


  it("projects disconnected path collisions deterministically without touching raw Yjs state", () => {
    expect(normalizeKitchenPath("appdata/a.md")).toBe("appdata/a.md");
    expect(normalizeKitchenPath("home/vault/a.md")).toBe("home/vault/a.md");
    const peers = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
    writeKitchenText(peers[0], "archive.md", "parent text");
    writeKitchenBytes(peers[1], "archive.md/nested", new Uint8Array([0, 255]));
    writeKitchenText(peers[2], "archive.md/nested/deep.txt", "deep text");
    const updates = peers.map((doc) => Y.encodeStateAsUpdate(doc));
    const expected = [
      "archive (file conflict 9b7862d0).md",
      "archive.md/nested (file conflict 64cbe202)",
      "archive.md/nested/deep.txt",
    ];
    for (const order of [[0, 1, 2], [2, 1, 0]]) {
      const doc = new Y.Doc();
      for (const index of order) Y.applyUpdate(doc, updates[index]);
      expect(listKitchenPaths(doc)).toEqual(expected);
      expect(readKitchenText(doc, expected[0])).toBe("parent text");
      expect(readKitchenBytes(doc, expected[1])).toEqual(new Uint8Array([0, 255]));
      expect(readKitchenText(doc, expected[2])).toBe("deep text");
      expect([...doc.share.keys()].filter((name) => name.startsWith("text:"))).toHaveLength(2);
      const durable = Y.encodeStateAsUpdate(doc);
      expect(listKitchenPaths(doc)).toEqual(expected);
      const reload = new Y.Doc();
      Y.applyUpdate(reload, durable);
      expect(listKitchenPaths(reload)).toEqual(expected);
    }
  });

  it("routes projected edits and rejects hidden raw overwrite", () => {
    const doc = new Y.Doc();
    kitchenFiles(doc).set(".md", "text");
    doc.getText("text:.md").insert(0, "kept");
    kitchenFiles(doc).set(".md/child.bin", new Uint8Array([1]));
    const alias = "file (file conflict 5e1d80d0).md";
    const seen: string[][] = [];
    const stop = observeKitchen(doc, (paths) => seen.push([...paths]));
    writeKitchenBytes(doc, alias, new TextEncoder().encode("edited"));
    expect(readKitchenText(doc, alias)).toBe("edited");
    expect(seen).toEqual([[alias]]);
    expect(() => writeKitchenBytes(doc, ".md", new Uint8Array([9]))).toThrow("raw path is hidden");
    stop();
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
