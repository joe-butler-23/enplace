import { afterEach, describe, expect, it, vi } from "vitest";
import { useVaultStorage, type VaultStorageAdapter } from "../host-client/browser-storage";
import { deleteRecipe, saveRecipe } from "./actions";

function adapterWithText(initial: string) {
  let text = initial;
  const remove = vi.fn(async () => undefined);
  const adapter = {
    readBytes: async () => new TextEncoder().encode(text),
    writeBytes: async () => undefined,
    writeNewBytes: async () => undefined,
    updateText: async (_path: string, update: (current: string) => string) => {
      text = update(text);
      return text;
    },
    remove,
    pathExists: async () => true,
    walkFiles: async () => [],
    fileUrl: async () => "blob:test",
  } satisfies VaultStorageAdapter;
  return { adapter, remove, text: () => text };
}

afterEach(() => useVaultStorage(null));

describe("recipe actions", () => {
  it("merges a stale editor draft with the current kitchen text", async () => {
    const base = "first: base\nsecond: base\n";
    const storage = adapterWithText("first: base\nsecond: remote\n");
    useVaultStorage(storage.adapter);

    const result = await saveRecipe("recipes/soup.md", base, "first: local\nsecond: base\n");

    expect(result).toEqual({ text: "first: local\nsecond: remote\n", conflicts: 0 });
    expect(storage.text()).toBe(result.text);
  });

  it("removes a recipe through the storage authority", async () => {
    const storage = adapterWithText("# Soup\n");
    useVaultStorage(storage.adapter);
    await deleteRecipe("recipes/soup.md");
    expect(storage.remove).toHaveBeenCalledWith("recipes/soup.md", false);
  });
});
