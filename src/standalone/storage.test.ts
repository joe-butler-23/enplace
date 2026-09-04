// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readText } from "../host-client/browser-storage";
import { openCookbook, type CookbookConnection } from "../host-client/cookbook-storage";
import { setCurrentCookbookConnection } from "../cookbook/current";
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
  setCurrentCookbookConnection(null);
});

let connection: CookbookConnection | null = null;
afterEach(async () => {
  setCurrentCookbookConnection(null);
  await connection?.close();
  connection = null;
});

describe("browser-local preferences", () => {
  it("loads defaults without writing browser-local state", async () => {
    await expect(loadSettings()).resolves.toEqual(DEFAULT_STANDALONE_SETTINGS);
    expect(window.localStorage.length).toBe(0);
  });

  it("persists only active browser-local values", async () => {
    await saveSettings({
      ...DEFAULT_STANDALONE_SETTINGS,
      databaseSort: "title-asc",
      databaseMarkedFilter: "marked"
    });

    const stored = JSON.parse(window.localStorage.getItem("enplace.preferences") ?? "{}");
    expect(stored).toMatchObject({ databaseSort: "title-asc", databaseMarkedFilter: "marked" });
    await expect(loadSettings()).resolves.toMatchObject({
      databaseSort: "title-asc",
      databaseMarkedFilter: "marked"
    });
  });

  it("moves legacy day notes into Plan.md once and removes them from preferences", async () => {
    connection = await openCookbook({ id: "abcdefghijklmnopqrstuvwxyz", relayUrl: null, persist: false });
    setCurrentCookbookConnection(connection);
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
