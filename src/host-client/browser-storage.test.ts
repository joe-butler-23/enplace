import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readText,
  updateText,
  useVaultStorage,
  pathExists,
  writeNewText,
  writeText,
  type VaultStorageAdapter,
} from "./browser-storage";

function memoryAdapter(initial: Record<string, string> = {}): VaultStorageAdapter & { writes: string[] } {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const files = new Map(Object.entries(initial).map(([path, text]) => [path, encoder.encode(text)]));
  const writes: string[] = [];
  return {
    writes,
    async readBytes(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`File not found: ${path}`);
      return bytes.slice();
    },
    async writeBytes(path, bytes) { files.set(path, bytes.slice()); writes.push(path); },
    async writeNewBytes(path, bytes) {
      if (files.has(path)) throw new Error("exists");
      files.set(path, bytes.slice());
      writes.push(path);
    },
    async writeNewBytesBatch(entries) {
      let imported = 0;
      for (const [path, bytes] of entries) {
        if (files.has(path)) continue;
        files.set(path, bytes.slice()); writes.push(path); imported += 1;
      }
      return imported;
    },
    async updateText(path, update) {
      const current = decoder.decode(files.get(path) ?? new Uint8Array());
      const next = update(current);
      if (next !== current) { files.set(path, encoder.encode(next)); writes.push(path); }
      return next;
    },
    async remove(path) { files.delete(path); },
    async pathExists(path) { return files.has(path); },
    async walkFiles() { return []; },
    async fileUrl(path) { return `memory:${path}`; },
  };
}

afterEach(() => useVaultStorage(null));

describe("vault storage adapter contract", () => {
  it("fails clearly when no adapter is selected", async () => {
    useVaultStorage(null);
    await expect(readText("Plan.md")).rejects.toThrow("No vault storage adapter is selected");
    expect(() => updateText("Plan.md", (text) => text)).toThrow("No vault storage adapter is selected");
  });

  it("delegates byte and text helpers to the selected adapter", async () => {
    const storage = memoryAdapter({ "a.md": "one" });
    useVaultStorage(storage);
    expect(await readText("a.md")).toBe("one");
    await writeText("a.md", "two");
    await writeNewText("b.md", "new");
    expect(await readText("a.md")).toBe("two");
    expect(await readText("b.md")).toBe("new");
    expect(await pathExists("b.md")).toBe(true);
  });

  it("delegates live text updates and does not write an unchanged result", async () => {
    const storage = memoryAdapter({ "Shopping.md": "milk\n" });
    const update = vi.spyOn(storage, "updateText");
    useVaultStorage(storage);
    await expect(updateText("Shopping.md", (current) => `${current}eggs\n`)).resolves.toBe("milk\neggs\n");
    const writes = storage.writes.length;
    await expect(updateText("Shopping.md", (current) => current)).resolves.toBe("milk\neggs\n");
    expect(storage.writes).toHaveLength(writes);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("keeps the public surface limited to live app operations", async () => {
    const contract = await import("./browser-storage");
    expect(contract).not.toHaveProperty("openDocument");
    expect(contract).not.toHaveProperty("digestText");
    expect(contract).not.toHaveProperty("stat");
    expect(contract).not.toHaveProperty("mkdir");
  });
});
