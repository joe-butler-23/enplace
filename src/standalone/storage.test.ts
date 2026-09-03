// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_STANDALONE_SETTINGS } from "./settings";
import { loadSettings, saveSettings } from "./storage";

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
});

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
