import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STANDALONE_SETTINGS } from "./settings";

const fsMock = vi.hoisted(() => ({
  BaseDirectory: { AppData: 14 },
  exists: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  mkdir: vi.fn()
}));

const pathMock = vi.hoisted(() => ({
  appDataDir: vi.fn(),
  homeDir: vi.fn(),
  join: vi.fn()
}));

vi.mock("@/host-client/fs", () => fsMock);
vi.mock("@/host-client/path", () => pathMock);

const APP_DATA_OPTIONS = { baseDir: fsMock.BaseDirectory.AppData };

describe("standalone storage startup paths", () => {
  beforeEach(() => {
    vi.resetModules();
    fsMock.readTextFile.mockReset();
    fsMock.writeTextFile.mockReset();
    fsMock.mkdir.mockReset();
    fsMock.exists.mockReset();

    pathMock.appDataDir.mockResolvedValue("/appdata");
    pathMock.homeDir.mockResolvedValue("/home/student");
    pathMock.join.mockImplementation(async (...parts: string[]) => {
      const cleaned = parts
        .filter((part) => part && part.length > 0)
        .map((part) => part.replace(/^\/+|\/+$/g, ""));
      return `/${cleaned.join("/")}`.replace(/\/+/g, "/");
    });
    fsMock.exists.mockResolvedValue(true);
  });

  it("reads settings through the AppData-scoped host filesystem", async () => {
    fsMock.readTextFile.mockRejectedValue(new Error("No such file or directory"));

    const { loadSettings } = await import("./storage");
    const settings = await loadSettings();

    expect(fsMock.readTextFile).toHaveBeenCalledWith("settings.json", APP_DATA_OPTIONS);
    expect(settings).toEqual(DEFAULT_STANDALONE_SETTINGS);
  });

  it("saves settings and provisions the app-data scope first", async () => {
    const { saveSettings } = await import("./storage");
    await saveSettings(DEFAULT_STANDALONE_SETTINGS);

    expect(fsMock.mkdir).toHaveBeenCalledWith(".", { ...APP_DATA_OPTIONS, recursive: true });
    expect(fsMock.writeTextFile).toHaveBeenCalledWith(
      "settings.json",
      JSON.stringify(DEFAULT_STANDALONE_SETTINGS, null, 2),
      APP_DATA_OPTIONS
    );
  });

  it("observes an unchanged provisioned startup without writes", async () => {
    const normalizedSettings = { ...DEFAULT_STANDALONE_SETTINGS, vaultPath: "/home/student/vault" };
    fsMock.readTextFile
      .mockResolvedValueOnce(
        JSON.stringify(Object.fromEntries(Object.entries(normalizedSettings).reverse()), null, 2)
      )
      .mockResolvedValueOnce(
        JSON.stringify(normalizedSettings, null, 2)
      );

    const { loadSettings, prepareStandaloneStartup } = await import("./storage");
    const settings = await loadSettings();
    await expect(prepareStandaloneStartup(settings)).resolves.toEqual(normalizedSettings);

    expect(fsMock.exists).toHaveBeenCalled();
    expect(fsMock.writeTextFile).not.toHaveBeenCalled();
  });

  it("persists changed normalized settings once at startup", async () => {
    fsMock.readTextFile
      .mockResolvedValueOnce(
        JSON.stringify({ ...DEFAULT_STANDALONE_SETTINGS, vaultPath: "/home/student/vault" }, null, 2)
      )
      .mockResolvedValueOnce(
        JSON.stringify({ ...DEFAULT_STANDALONE_SETTINGS, vaultPath: "/home/student/vault" }, null, 2)
      );

    const { loadSettings, prepareStandaloneStartup } = await import("./storage");
    const settings = await loadSettings();
    await prepareStandaloneStartup({ ...settings, recipesFolder: "dishes" });

    expect(JSON.parse(fsMock.writeTextFile.mock.calls[0][1])).toMatchObject({ recipesFolder: "dishes" });
  });

  it("drops obsolete settings keys and persists only the active schema", async () => {
    fsMock.readTextFile.mockResolvedValue(
      JSON.stringify({ ...DEFAULT_STANDALONE_SETTINGS, obsoleteIntegrationKey: "remove-me" })
    );

    const { loadSettings, prepareStandaloneStartup } = await import("./storage");
    const settings = await loadSettings();
    await prepareStandaloneStartup(settings);

    expect(settings).toEqual(DEFAULT_STANDALONE_SETTINGS);
    const persisted = JSON.parse(fsMock.writeTextFile.mock.calls[0][1]);
    expect(persisted).toEqual({
      ...DEFAULT_STANDALONE_SETTINGS,
      vaultPath: "/home/student/vault"
    });
  });

  it("throws on invalid settings JSON instead of silently resetting defaults", async () => {
    fsMock.readTextFile.mockResolvedValue("{invalid");

    const { loadSettings } = await import("./storage");
    await expect(loadSettings()).rejects.toThrow("Invalid JSON in settings.json");
    expect(fsMock.writeTextFile).not.toHaveBeenCalled();
  });

  it("loads and saves the ledger in the app-data scope", async () => {
    fsMock.readTextFile.mockRejectedValue(new Error("No such file or directory"));

    const { loadLedger, saveLedger } = await import("./storage");
    await expect(loadLedger()).resolves.toEqual([]);

    fsMock.readTextFile.mockResolvedValue(JSON.stringify([{ id: "a" }]));
    await saveLedger([{ id: "b" } as never]);

    expect(fsMock.readTextFile).toHaveBeenCalledWith("ledger.json", APP_DATA_OPTIONS);
    expect(fsMock.writeTextFile).toHaveBeenCalledWith(
      "ledger.json",
      JSON.stringify([{ id: "b" }], null, 2),
      APP_DATA_OPTIONS
    );
  });

  it("defaults an empty vault path to ~/vault/cooking", async () => {
    const { ensureVaultPath } = await import("./storage");
    await expect(ensureVaultPath("")).resolves.toBe("/home/student/vault/cooking");
    expect(fsMock.mkdir).toHaveBeenCalledWith("/home/student/vault/cooking", { recursive: true });
  });

  it("allows vault paths under ~/vault", async () => {
    const { ensureVaultPath } = await import("./storage");
    await expect(ensureVaultPath("~/vault/cooking")).resolves.toBe("/home/student/vault/cooking");
    expect(fsMock.mkdir).toHaveBeenCalledWith("/home/student/vault/cooking", { recursive: true });
  });

  it("falls back when a vault path is outside ~/vault", async () => {
    const { ensureVaultPath } = await import("./storage");
    await expect(ensureVaultPath("/tmp/other-vault")).resolves.toBe("/home/student/vault/cooking");
    expect(fsMock.mkdir).toHaveBeenCalledWith("/home/student/vault/cooking", { recursive: true });
  });
});
