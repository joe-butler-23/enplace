import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyTextDiff,
  deleteCookbookPath,
  hasCookbookDirectory,
  isCookbookId,
  cookbookFiles,
  cookbookIdFromUrl,
  cookbookLink,
  listCookbookPaths,
  newCookbookId,
  normalizeCookbookPath,
  observeCookbook,
  readCookbookBytes,
  readCookbookText,
  withCookbookHash,
  writeCookbookBytes,
  writeCookbookText,
} from "./doc";

function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

describe("cookbook document", () => {
  it("stores text files as Y.Text and other files as bytes", () => {
    const doc = new Y.Doc();
    writeCookbookText(doc, "Shopping.md", "## Soup\n- [ ] onion\n");
    writeCookbookBytes(doc, "images/cover.webp", new Uint8Array([1, 2, 3]));
    expect(readCookbookText(doc, "Shopping.md")).toBe("## Soup\n- [ ] onion\n");
    expect(readCookbookBytes(doc, "images/cover.webp")).toEqual(new Uint8Array([1, 2, 3]));
    expect(listCookbookPaths(doc)).toEqual(["images/cover.webp", "Shopping.md"]);
    expect(hasCookbookDirectory(doc, "images")).toBe(true);
    expect(hasCookbookDirectory(doc, "recipes")).toBe(false);
  });


  it("projects disconnected path collisions deterministically without touching raw Yjs state", () => {
    expect(normalizeCookbookPath("appdata/a.md")).toBe("appdata/a.md");
    expect(normalizeCookbookPath("home/vault/a.md")).toBe("home/vault/a.md");
    const peers = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
    writeCookbookText(peers[0], "archive.md", "parent text");
    writeCookbookBytes(peers[1], "archive.md/nested", new Uint8Array([0, 255]));
    writeCookbookText(peers[2], "archive.md/nested/deep.txt", "deep text");
    const updates = peers.map((doc) => Y.encodeStateAsUpdate(doc));
    const expected = [
      "archive (file conflict 9b7862d0).md",
      "archive.md/nested (file conflict 64cbe202)",
      "archive.md/nested/deep.txt",
    ];
    for (const order of [[0, 1, 2], [2, 1, 0]]) {
      const doc = new Y.Doc();
      for (const index of order) Y.applyUpdate(doc, updates[index]);
      expect(listCookbookPaths(doc)).toEqual(expected);
      expect(readCookbookText(doc, expected[0])).toBe("parent text");
      expect(readCookbookBytes(doc, expected[1])).toEqual(new Uint8Array([0, 255]));
      expect(readCookbookText(doc, expected[2])).toBe("deep text");
      expect([...doc.share.keys()].filter((name) => name.startsWith("text:"))).toHaveLength(2);
      const durable = Y.encodeStateAsUpdate(doc);
      expect(listCookbookPaths(doc)).toEqual(expected);
      const reload = new Y.Doc();
      Y.applyUpdate(reload, durable);
      expect(listCookbookPaths(reload)).toEqual(expected);
    }
  });

  it("routes projected edits and rejects hidden raw overwrite", () => {
    const doc = new Y.Doc();
    cookbookFiles(doc).set(".md", "text");
    doc.getText("text:.md").insert(0, "kept");
    cookbookFiles(doc).set(".md/child.bin", new Uint8Array([1]));
    const alias = "file (file conflict 5e1d80d0).md";
    const seen: string[][] = [];
    const stop = observeCookbook(doc, (paths) => seen.push([...paths]));
    writeCookbookBytes(doc, alias, new TextEncoder().encode("edited"));
    expect(readCookbookText(doc, alias)).toBe("edited");
    expect(seen).toEqual([[alias]]);
    expect(() => writeCookbookBytes(doc, ".md", new Uint8Array([9]))).toThrow("raw path is hidden");
    stop();
  });

  it("applies the smallest edit so concurrent line edits merge", () => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    writeCookbookText(left, "Shopping.md", "- [ ] milk\n- [ ] eggs\n");
    sync(left, right);
    writeCookbookText(left, "Shopping.md", "- [x] milk\n- [ ] eggs\n");
    writeCookbookText(right, "Shopping.md", "- [ ] milk\n- [x] eggs\n");
    sync(left, right);
    sync(right, left);
    expect(readCookbookText(left, "Shopping.md")).toBe("- [x] milk\n- [x] eggs\n");
    expect(readCookbookText(right, "Shopping.md")).toBe(readCookbookText(left, "Shopping.md"));
  });

  it("keeps both sides when two devices create the same file at once", () => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    writeCookbookText(left, "Shopping.md", "## Other\n- [ ] milk\n");
    writeCookbookText(right, "Shopping.md", "## Other\n- [ ] eggs\n");
    sync(left, right);
    sync(right, left);
    const merged = readCookbookText(left, "Shopping.md") ?? "";
    expect(merged).toBe(readCookbookText(right, "Shopping.md"));
    expect(merged).toContain("- [ ] milk");
    expect(merged).toContain("- [ ] eggs");
    expect(listCookbookPaths(left)).toEqual(["Shopping.md"]);
  });

  it("deletes files and directories", () => {
    const doc = new Y.Doc();
    writeCookbookText(doc, "recipes/a.md", "# A");
    writeCookbookText(doc, "recipes/b.md", "# B");
    expect(() => deleteCookbookPath(doc, "recipes")).toThrow(/not empty/);
    expect(deleteCookbookPath(doc, "recipes", true).sort()).toEqual(["recipes/a.md", "recipes/b.md"]);
    expect(listCookbookPaths(doc)).toEqual([]);
    expect(() => deleteCookbookPath(doc, "missing.md")).toThrow(/not found/);
  });

  it("makes unguessable ids that travel in the URL fragment", () => {
    const id = newCookbookId();
    expect(isCookbookId(id)).toBe(true);
    expect(newCookbookId()).not.toBe(id);
    expect(cookbookIdFromUrl(cookbookLink("https://enplace.app", id, "/shopping"))).toBe(id);
    expect(cookbookIdFromUrl("https://enplace.app/?k=nope")).toBeNull();
    expect(withCookbookHash("/planner?view=week", id)).toBe(`/planner?view=week#k=${id}`);
  });
});
