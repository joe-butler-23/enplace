import { appDataDir, homeDir, join } from "@/host-client/path";
import { BaseDirectory, exists, mkdir, readTextFile, writeTextFile } from "@/host-client/fs";
import type { LedgerEntry } from "@/services/LedgerStore";
import { DEFAULT_STANDALONE_SETTINGS, type StandaloneSettings } from "./settings";

const settingsFileName = "settings.json";
const ledgerFileName = "ledger.json";

export const APP_DATA_FS_OPTIONS = { baseDir: BaseDirectory.AppData } as const;

type JsonFileOptions = { baseDir?: BaseDirectory };

// All settings and ledger state live in the host-managed app-data scope.
async function ensureAppDataDirExists(): Promise<void> {
  await mkdir(".", { ...APP_DATA_FS_OPTIONS, recursive: true });
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "";
}

function isMissingFileError(error: unknown): boolean {
  const message = extractErrorMessage(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("not found") ||
    normalized.includes("no such file") ||
    normalized.includes("cannot find the path specified") ||
    normalized.includes("the system cannot find the file specified")
  );
}

async function readJsonFile<T>(
  path: string,
  parse: (value: unknown) => T,
  fallback: () => T,
  options?: JsonFileOptions
): Promise<T> {
  let raw = "";
  try {
    raw = await readTextFile(path, options);
  } catch (error) {
    if (isMissingFileError(error)) {
      return fallback();
    }
    throw error;
  }

  if (!raw.trim()) {
    return fallback();
  }

  try {
    return parse(JSON.parse(raw));
  } catch (error) {
    const reason = extractErrorMessage(error) || "unknown parse error";
    throw new Error(`Invalid JSON in ${path}: ${reason}`);
  }
}

async function writeJsonFile(path: string, value: unknown, options?: JsonFileOptions): Promise<void> {
  await writeTextFile(path, serializeJson(value), options);
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function serializeCanonicalJson(value: unknown): string {
  const canonicalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonicalize);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(
      Object.entries(entry)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  };
  return serializeJson(canonicalize(value));
}

export async function getAppDataPath(): Promise<string> {
  return appDataDir();
}

export async function getSettingsPath(): Promise<string> {
  return join(await appDataDir(), settingsFileName);
}

export async function getLedgerPath(): Promise<string> {
  return join(await appDataDir(), ledgerFileName);
}

export async function loadSettings(): Promise<StandaloneSettings> {
  const parseSettings = (value: unknown): StandaloneSettings => {
    const stored = value && typeof value === "object"
      ? value as Partial<StandaloneSettings>
      : {};
    const keys = Object.keys(DEFAULT_STANDALONE_SETTINGS) as Array<keyof StandaloneSettings>;
    return Object.fromEntries(
      keys.map((key) => [key, stored[key] ?? DEFAULT_STANDALONE_SETTINGS[key]])
    ) as unknown as StandaloneSettings;
  };
  const fallbackSettings = () => ({ ...DEFAULT_STANDALONE_SETTINGS });
  return readJsonFile(settingsFileName, parseSettings, fallbackSettings, APP_DATA_FS_OPTIONS);
}

export async function saveSettings(settings: StandaloneSettings): Promise<void> {
  await ensureAppDataDirExists();
  await writeJsonFile(settingsFileName, settings, APP_DATA_FS_OPTIONS);
}

async function storedSettingsMatch(settings: StandaloneSettings): Promise<boolean> {
  const expected = serializeCanonicalJson(settings);
  const matches = async (path: string, options?: JsonFileOptions): Promise<boolean> => {
    let raw: string;
    try {
      raw = await readTextFile(path, options);
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw error;
    }
    if (!raw.trim()) return false;
    try {
      return serializeCanonicalJson(JSON.parse(raw)) === expected;
    } catch (error) {
      const reason = extractErrorMessage(error) || "unknown parse error";
      throw new Error(`Invalid JSON in ${path}: ${reason}`);
    }
  };

  return matches(settingsFileName, APP_DATA_FS_OPTIONS);
}

export async function loadLedger(): Promise<LedgerEntry[]> {
  const parseLedger = (value: unknown) => (Array.isArray(value) ? (value as LedgerEntry[]) : []);
  const fallbackLedger = () => [];
  return readJsonFile(ledgerFileName, parseLedger, fallbackLedger, APP_DATA_FS_OPTIONS);
}

export async function saveLedger(entries: LedgerEntry[]): Promise<void> {
  await ensureAppDataDirExists();
  await writeJsonFile(ledgerFileName, entries, APP_DATA_FS_OPTIONS);
}

export async function resolveVaultPath(vaultPath: string): Promise<string> {
  const homeDirResolved = await homeDir();
  const [defaultVaultPath, vaultRoot] = await Promise.all([
    join(homeDirResolved, "vault", "cooking"),
    join(homeDirResolved, "vault")
  ]);
  let resolved = vaultPath;
  if (!resolved) {
    resolved = defaultVaultPath;
  } else if (resolved === "~") {
    resolved = homeDirResolved;
  } else if (resolved.startsWith("~/")) {
    resolved = await join(homeDirResolved, resolved.slice(2));
  }
  const normalizedResolved = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedRoot = vaultRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (
    normalizedResolved !== normalizedRoot &&
    !normalizedResolved.startsWith(`${normalizedRoot}/`)
  ) {
    console.warn(`Vault path ${resolved} is outside ~/vault; using ${defaultVaultPath}.`);
    resolved = defaultVaultPath;
  }
  return resolved;
}

export async function ensureVaultPath(vaultPath: string): Promise<string> {
  const resolved = await resolveVaultPath(vaultPath);
  await mkdir(resolved, { recursive: true });
  return resolved;
}

async function vaultStructureExists(settings: StandaloneSettings): Promise<{ vaultPath: string; exists: boolean }> {
  const vaultPath = await resolveVaultPath(settings.vaultPath);
  const folders = [
    vaultPath,
    settings.recipesFolder,
    settings.imagesFolder,
    settings.eventsFolder
  ];
  const paths = await Promise.all(
    folders.filter(Boolean).map((folder) => (folder === vaultPath ? vaultPath : join(vaultPath, folder)))
  );
  return { vaultPath, exists: (await Promise.all(paths.map((path) => exists(path)))).every(Boolean) };
}

export async function ensureVaultStructure(settings: StandaloneSettings): Promise<string> {
  const vaultRoot = await ensureVaultPath(settings.vaultPath);
  const folders = [
    settings.recipesFolder,
    settings.imagesFolder,
    settings.eventsFolder
  ];
  for (const folder of folders) {
    if (!folder) continue;
    const fullPath = await join(vaultRoot, folder);
    await mkdir(fullPath, { recursive: true });
  }
  return vaultRoot;
}

export async function prepareStandaloneStartup(settings: StandaloneSettings): Promise<StandaloneSettings> {
  const observed = await vaultStructureExists(settings);
  const normalized = { ...settings, vaultPath: observed.vaultPath };
  if (!observed.exists) {
    await ensureVaultStructure(normalized);
  }
  if (!(await storedSettingsMatch(normalized))) {
    await saveSettings(normalized);
  }
  return normalized;
}
