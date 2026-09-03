// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { readText, useVaultStorage, type VaultStorageAdapter } from "../host-client/browser-storage";
import { DEFAULT_STANDALONE_SETTINGS } from "./settings";
import { loadSettings, prepareStandaloneStartup, saveSettings } from "./storage";

const values = new Map<string, string>();
const storage: Storage = {
  get length() { return values.size; },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => { values.delete(key); },
  setItem: (key, value) => { values.set(key, String(value)); }
};

beforeEach(() => {
  values.clear();
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  useVaultStorage(null);
});

function textAdapter(): VaultStorageAdapter {
  const files = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    async readBytes(path) {
      const value = files.get(path);
      if (!value) throw new Error(`File not found: ${path}`);
      return value;
    },
    async writeBytes(path, bytes) { files.set(path, bytes); },
    async writeNewBytes(path, bytes) { files.set(path, bytes); },
    async writeNewBytesBatch(entries) {
      let imported = 0;
      for (const [path, bytes] of entries) if (!files.has(path)) { files.set(path, bytes); imported += 1; }
      return imported;
    },
    async updateText(path, update) {
      const next = update(decoder.decode(files.get(path) ?? new Uint8Array()));
      files.set(path, encoder.encode(next));
      return next;
    },
    async remove(path) { files.delete(path); },
    async pathExists(path) { return files.has(path); },
    async walkFiles() { return []; },
    async fileUrl() { return ""; },
  };
}

describe("browser-local preferences", () => {
  it("loads defaults without writing to the selected folder or browser storage", async () => {
    await expect(loadSettings()).resolves.toEqual(DEFAULT_STANDALONE_SETTINGS);
    expect(window.localStorage.length).toBe(0);
  });

  it("persists only active browser-local values", async () => {
    await saveSettings({
      ...DEFAULT_STANDALONE_SETTINGS,
      databaseSort: "title-asc",
      databaseMarkedFilter: "marked",
      vaultPath: "/ignored"
    });

    const stored = JSON.parse(window.localStorage.getItem("enplace.preferences") ?? "{}");
    expect(stored).toMatchObject({ databaseSort: "title-asc", databaseMarkedFilter: "marked" });
    expect(stored).not.toHaveProperty("vaultPath");
    await expect(loadSettings()).resolves.toMatchObject({
      databaseSort: "title-asc",
      databaseMarkedFilter: "marked"
    });
  });

  it("moves legacy day notes into Plan.md once and removes them from preferences", async () => {
    useVaultStorage(textAdapter());
    window.localStorage.setItem("enplace.preferences", JSON.stringify({
      ...DEFAULT_STANDALONE_SETTINGS,
      dayNotes: { "2026-09-04": "Grandma visiting, cook early" },
    }));

    const settings = await loadSettings();
    expect(settings).not.toHaveProperty("dayNotes");
    await prepareStandaloneStartup(settings);

    await expect(readText("Plan.md")).resolves.toContain("## 2026-09-04\n> Grandma visiting, cook early\n");
    expect(JSON.parse(window.localStorage.getItem("enplace.preferences") ?? "{}")).not.toHaveProperty("dayNotes");
  });

  it("drops stale keys when preferences are saved", async () => {
    window.localStorage.setItem("enplace.preferences", JSON.stringify({
      ...DEFAULT_STANDALONE_SETTINGS,
      recipesFolder: "recipes",
      imagesFolder: "images"
    }));
    await saveSettings(await loadSettings());
    const stored = JSON.parse(window.localStorage.getItem("enplace.preferences") ?? "{}");
    expect(stored).not.toHaveProperty("recipesFolder");
    expect(stored).not.toHaveProperty("imagesFolder");
  });

  it("reports malformed preferences instead of silently replacing them", async () => {
    window.localStorage.setItem("enplace.preferences", "{invalid");
    await expect(loadSettings()).rejects.toThrow("Invalid browser preferences");
  });
});
