import {
  decodeBase64 as decodeRemoteBase64,
  encodeBase64 as encodeRemoteBase64,
  getRemoteHostConfig,
  remoteHostJson
} from "./remote-host";

type FileEntry = {
  path: string;
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size?: number;
  mtime?: Date | string | null;
  children?: FileEntry[];
};

type DirEntry = Omit<FileEntry, "path" | "children">;

type RecursiveDirEntry = DirEntry & {
  children?: RecursiveDirEntry[];
};

type RecursiveOptions = {
  recursive?: boolean;
};

export enum BaseDirectory {
  Audio = 1,
  Cache = 2,
  Config = 3,
  Data = 4,
  LocalData = 5,
  Document = 6,
  Download = 7,
  Picture = 8,
  Public = 9,
  Video = 10,
  Resource = 11,
  Temp = 12,
  AppConfig = 13,
  AppData = 14,
  AppLocalData = 15,
  AppCache = 16,
  AppLog = 17,
  Desktop = 18,
  Executable = 19,
  Font = 20,
  Home = 21,
  Runtime = 22,
  Template = 23
}

type BaseDirOptions = {
  baseDir?: BaseDirectory;
};

type FileInfo = {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtime: Date | null;
};

type PermissionMode = "read" | "readwrite";
type PermissionStateLike = "granted" | "denied" | "prompt";

type FileBlobLike = {
  size: number;
  lastModified?: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

type WritableLike = {
  write(data: string | ArrayBuffer | Uint8Array | ArrayBufferView | Blob): Promise<void>;
  close(): Promise<void>;
};

type FileHandleLike = {
  kind: "file";
  name: string;
  getFile(): Promise<FileBlobLike>;
  createWritable(): Promise<WritableLike>;
  queryPermission?(descriptor?: { mode?: PermissionMode }): Promise<PermissionStateLike>;
  requestPermission?(descriptor?: { mode?: PermissionMode }): Promise<PermissionStateLike>;
};

type DirectoryHandleLike = {
  kind: "directory";
  name: string;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<DirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry?(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries?(): AsyncIterable<[string, FileSystemHandleLike]>;
  values?(): AsyncIterable<FileSystemHandleLike>;
  queryPermission?(descriptor?: { mode?: PermissionMode }): Promise<PermissionStateLike>;
  requestPermission?(descriptor?: { mode?: PermissionMode }): Promise<PermissionStateLike>;
};

type FileSystemHandleLike = FileHandleLike | DirectoryHandleLike;

type VirtualFsState = {
  files: Map<string, Uint8Array>;
  directories: Set<string>;
};

type VirtualFsSnapshot = {
  directories: string[];
  files: Array<{ path: string; data: string }>;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BASE_DIR_ROOTS: Partial<Record<BaseDirectory, string>> = {
  [BaseDirectory.AppConfig]: "/appconfig",
  [BaseDirectory.AppData]: "/appdata",
  [BaseDirectory.AppLocalData]: "/applocaldata",
  [BaseDirectory.AppCache]: "/appcache",
  [BaseDirectory.AppLog]: "/applog",
  [BaseDirectory.Home]: "/home",
  [BaseDirectory.Document]: "/home/Documents",
  [BaseDirectory.Desktop]: "/home/Desktop",
  [BaseDirectory.Download]: "/home/Downloads",
  [BaseDirectory.Picture]: "/home/Pictures",
  [BaseDirectory.Public]: "/home/Public",
  [BaseDirectory.Video]: "/home/Videos",
  [BaseDirectory.Temp]: "/tmp"
};
const VIRTUAL_FS_STORAGE_KEY = "mep:web-fs:v2";
const MOUNTED_VAULT_META_KEY = "mep:web-vault:v1";
const MOUNTED_VAULT_ROOT = "/home/vault";
const MOUNTED_VAULT_DB = "mep-web-vault";
const MOUNTED_VAULT_STORE = "handles";
const MOUNTED_VAULT_HANDLE_KEY = "active-vault";

const memoryStorage = new Map<string, string>();

let mountedVaultHandleCache: DirectoryHandleLike | null | undefined;

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (normalized === "/") return "/";
  return normalized.replace(/\/+$/, "") || "/";
}

function ensureLeadingSlash(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

function toPathString(path: string | URL): string {
  return typeof path === "string" ? path : path.pathname;
}

function resolvePath(path: string | URL, options?: BaseDirOptions): string {
  const raw = toPathString(path).replace(/\\/g, "/");
  if (raw.startsWith("/")) {
    return normalizePath(raw);
  }

  const baseRoot = options?.baseDir ? BASE_DIR_ROOTS[options.baseDir] ?? "/" : "/";
  const relative = raw.replace(/^\.\/+/, "");
  if (!relative || relative === ".") {
    return normalizePath(ensureLeadingSlash(baseRoot));
  }

  return normalizePath(ensureLeadingSlash(`${baseRoot}/${relative}`));
}

async function remoteFs<T>(operation: string, payload: Record<string, unknown>): Promise<T> {
  if (!getRemoteHostConfig()) {
    throw new Error("Remote host runtime is not configured.");
  }
  return remoteHostJson<T>(`/fs/${operation}`, payload);
}

function getParent(value: string): string {
  const normalized = normalizePath(value);
  if (normalized === "/") return "/";
  const parts = normalized.split("/");
  parts.pop();
  return parts.join("/") || "/";
}

function getStorage(): StorageLike {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage;
    }
  } catch {
    // ignore storage access failures and fall back to memory
  }

  return {
    getItem(key: string) {
      return memoryStorage.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      memoryStorage.set(key, value);
    },
    removeItem(key: string) {
      memoryStorage.delete(key);
    }
  };
}

function serializeVirtualState(state: VirtualFsState): string {
  const payload: VirtualFsSnapshot = {
    directories: Array.from(state.directories).sort(),
    files: Array.from(state.files.entries())
      .map(([path, data]) => ({ path, data: encodeRemoteBase64(data) }))
      .sort((a, b) => a.path.localeCompare(b.path))
  };
  return JSON.stringify(payload);
}

function restoreVirtualState(): VirtualFsState {
  const storage = getStorage();
  const raw = storage.getItem(VIRTUAL_FS_STORAGE_KEY);
  if (!raw) {
    return {
      files: new Map<string, Uint8Array>(),
      directories: new Set<string>(["/"])
    };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<VirtualFsSnapshot>;
    const directories = new Set<string>(["/"]);
    for (const dir of parsed.directories ?? []) {
      if (typeof dir === "string") {
        directories.add(normalizePath(ensureLeadingSlash(dir)));
      }
    }
    const files = new Map<string, Uint8Array>();
    for (const entry of parsed.files ?? []) {
      if (!entry || typeof entry.path !== "string" || typeof entry.data !== "string") {
        continue;
      }
      files.set(
        normalizePath(ensureLeadingSlash(entry.path)),
        decodeRemoteBase64(entry.data)
      );
    }
    return { files, directories };
  } catch {
    storage.removeItem(VIRTUAL_FS_STORAGE_KEY);
    return {
      files: new Map<string, Uint8Array>(),
      directories: new Set<string>(["/"])
    };
  }
}

const fsState = restoreVirtualState();

function persistVirtualState(): void {
  try {
    getStorage().setItem(VIRTUAL_FS_STORAGE_KEY, serializeVirtualState(fsState));
  } catch {
    // ignore storage quota and serialization failures in the web shim
  }
}

function shouldSeedDeterministicVault(): boolean {
  const globalFlags = globalThis as {
    __MEP_DISABLE_SHIM_FIXTURE__?: boolean;
    __MEP_SHIM_FIXTURE__?: boolean;
  };
  if (globalFlags.__MEP_DISABLE_SHIM_FIXTURE__ === true) {
    return false;
  }
  if (globalFlags.__MEP_SHIM_FIXTURE__ === true) {
    return true;
  }
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const fixtureParam = params.get("mepFixture");
    if (fixtureParam === "0") return false;
    if (fixtureParam === "1" || fixtureParam === "2" || fixtureParam === "visual") return true;
  }
  return true;
}

function deterministicFixtureMode(): "small" | "visual" {
  const globalFlags = globalThis as {
    __MEP_SHIM_FIXTURE_MODE__?: "small" | "visual";
  };
  if (globalFlags.__MEP_SHIM_FIXTURE_MODE__ === "visual") return "visual";
  if (typeof window !== "undefined") {
    const fixtureParam = new URLSearchParams(window.location.search).get("mepFixture");
    if (fixtureParam === "visual" || fixtureParam === "2") return "visual";
  }
  return "small";
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function startOfIsoWeek(value: Date): Date {
  const copy = new Date(value);
  copy.setHours(0, 0, 0, 0);
  const weekday = copy.getDay();
  const mondayOffset = (weekday + 6) % 7;
  copy.setDate(copy.getDate() - mondayOffset);
  return copy;
}

function addDays(value: Date, days: number): Date {
  const copy = new Date(value);
  copy.setDate(copy.getDate() + days);
  return copy;
}

const VISUAL_INLINE_IMAGE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#304b63"/><circle cx="320" cy="180" r="96" fill="#f5c26b"/></svg>')}`;

function composeFixtureRecipe(title: string, scheduled: string | null, body: string, includeVisualImage = false): string {
  const scheduledLine = scheduled ? `scheduled: "${scheduled}"\n` : "";
  const visualBody = includeVisualImage ? `${body}\n\n![Deterministic visual fixture](${VISUAL_INLINE_IMAGE})` : body;
  return `---\ntitle: "${title}"\ntype: "recipe"\n${scheduledLine}marked: false\n---\n\n${visualBody}\n`;
}

function composeVisualFixtureRecipe(index: number, weekStart: Date): string {
  const added = `2026-06-${String(1 + (index % 16)).padStart(2, "0")}`;
  const scheduled = index % 4 === 0 ? toIsoDate(addDays(weekStart, index % 7)) : null;
  const marked = index % 7 === 0;
  const coverKind = index % 3;
  const cover = `images/visual-cover-${coverKind}.svg`;
  const title = index % 16 === 15
    ? `Duplicate Date Fixture ${String(index + 1).padStart(3, "0")}`
    : `Visual Fixture ${String(index + 1).padStart(3, "0")}`;
  const scheduledLine = scheduled ? `scheduled: "${scheduled}"\n` : "";
  return [
    "---",
    `title: "${title}"`,
    'type: "recipe"',
    `added: "${added}"`,
    scheduledLine.trimEnd(),
    `marked: ${marked}`,
    `cover: "${cover}"`,
    "---",
    "",
    `Deterministic visual harness recipe ${index + 1}.`,
    `![Visual fixture image ${index + 1}](${VISUAL_INLINE_IMAGE})`,
    "",
  ].filter(Boolean).join("\n");
}

function composeFixtureNote(
  title: string,
  type: "task" | "exercise" | "reminder",
  scheduled: string,
  body: string
): string {
  return `---\ntitle: "${title}"\ntype: "${type}"\nscheduled: "${scheduled}"\nmarked: false\n---\n\n${body}\n`;
}

function ensureVirtualDir(path: string): void {
  const normalized = normalizePath(ensureLeadingSlash(path));
  if (fsState.directories.has(normalized)) return;
  const parts = normalized.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = `${current}/${part}`;
    fsState.directories.add(current);
  }
}

function seedTextFile(path: string, contents: string): void {
  const normalized = normalizePath(ensureLeadingSlash(path));
  ensureVirtualDir(getParent(normalized));
  if (fsState.files.has(normalized)) {
    return;
  }
  fsState.files.set(normalized, encoder.encode(contents));
}

function seedBinaryFile(path: string, data: Uint8Array): void {
  const normalized = normalizePath(ensureLeadingSlash(path));
  ensureVirtualDir(getParent(normalized));
  if (fsState.files.has(normalized)) return;
  fsState.files.set(normalized, new Uint8Array(data));
}

function visualFixtureSvg(width: number, height: number, hue: number): Uint8Array {
  return encoder.encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="hsl(${hue} 55% 42%)"/><circle cx="${Math.round(width / 2)}" cy="${Math.round(height / 2)}" r="${Math.max(8, Math.round(Math.min(width, height) / 4))}" fill="hsl(${(hue + 45) % 360} 70% 78%)"/></svg>`
  );
}

function seedDeterministicVault(): void {
  if (!shouldSeedDeterministicVault()) {
    return;
  }

  const fixtureMode = deterministicFixtureMode();
  (globalThis as { __MEP_SHIM_FIXTURE_ID__?: string }).__MEP_SHIM_FIXTURE_ID__ =
    `${fixtureMode}-v1`;

  const homeVaultRoot = MOUNTED_VAULT_ROOT;
  const weekStart = startOfIsoWeek(new Date());
  const tuesday = toIsoDate(addDays(weekStart, 1));
  const wednesday = toIsoDate(addDays(weekStart, 2));
  const thursday = toIsoDate(addDays(weekStart, 3));
  const friday = toIsoDate(addDays(weekStart, 4));
  const saturday = toIsoDate(addDays(weekStart, 5));

  ensureVirtualDir(homeVaultRoot);
  ensureVirtualDir(`${homeVaultRoot}/recipes`);
  ensureVirtualDir(`${homeVaultRoot}/recipes/images`);
  ensureVirtualDir(`${homeVaultRoot}/events`);

  if (fixtureMode === "visual") {
    seedBinaryFile(`${homeVaultRoot}/recipes/images/visual-cover-0.svg`, visualFixtureSvg(640, 360, 18));
    seedBinaryFile(`${homeVaultRoot}/recipes/images/visual-cover-1.svg`, visualFixtureSvg(640, 360, 96));
    seedBinaryFile(`${homeVaultRoot}/recipes/images/visual-cover-2.svg`, visualFixtureSvg(640, 360, 174));
    for (let index = 0; index < 512; index += 1) {
      seedTextFile(
        `${homeVaultRoot}/recipes/visual-fixture-${String(index + 1).padStart(3, "0")}.md`,
        composeVisualFixtureRecipe(index, weekStart)
      );
    }
  }

  seedTextFile(
    `${homeVaultRoot}/recipes/fixture-coq-au-riesling.md`,
    composeFixtureRecipe(
      "Coq Au Riesling",
      tuesday,
      "Deterministic fixture recipe for planner drag-and-drop diagnostics.",
      fixtureMode === "visual"
    )
  );
  seedTextFile(
    `${homeVaultRoot}/recipes/fixture-lemon-potatoes.md`,
    composeFixtureRecipe(
      "Lemon Potatoes",
      tuesday,
      "Second fixture recipe scheduled on the same day to validate multi-card behavior.",
      fixtureMode === "visual"
    )
  );
  seedTextFile(
    `${homeVaultRoot}/recipes/fixture-braised-chickpeas.md`,
    composeFixtureRecipe(
      "Braised Chickpeas",
      wednesday,
      "Fixture recipe scheduled on a separate day for move and copy tests.",
      fixtureMode === "visual"
    )
  );
  seedTextFile(
    `${homeVaultRoot}/recipes/fixture-unscheduled-soup.md`,
    composeFixtureRecipe(
      "Unscheduled Green Soup",
      null,
      "Fixture recipe intentionally left unscheduled.",
      fixtureMode === "visual"
    )
  );

  seedTextFile(
    `${homeVaultRoot}/events/fixture-reminder.md`,
    composeFixtureNote(
      "Household Logistics",
      "reminder",
      thursday,
      "Fixture reminder card for weekly preset coverage."
    )
  );
  seedTextFile(
    `${homeVaultRoot}/events/fixture-strength-session.md`,
    composeFixtureNote(
      "Strength Session",
      "exercise",
      friday,
      "Fixture exercise card for weekly preset coverage."
    )
  );
  seedTextFile(
    `${homeVaultRoot}/events/fixture-admin-task.md`,
    composeFixtureNote(
      "Admin Task",
      "task",
      saturday,
      "Fixture task card for weekly preset coverage."
    )
  );

  persistVirtualState();
}

seedDeterministicVault();

function listVirtualChildren(directory: string): FileEntry[] {
  const normalized = normalizePath(ensureLeadingSlash(directory));
  const entries: FileEntry[] = [];
  const seen = new Set<string>();

  for (const dir of fsState.directories) {
    if (dir === "/") continue;
    if (getParent(dir) === normalized && !seen.has(dir)) {
      entries.push({
        path: dir,
        name: dir.split("/").pop() ?? "",
        isFile: false,
        isDirectory: true,
        isSymlink: false,
        children: []
      });
      seen.add(dir);
    }
  }

  for (const filePath of fsState.files.keys()) {
    if (getParent(filePath) === normalized && !seen.has(filePath)) {
      entries.push({
        path: filePath,
        name: filePath.split("/").pop() ?? "",
        isFile: true,
        isDirectory: false,
        isSymlink: false
      });
      seen.add(filePath);
    }
  }

  return entries;
}

function isMountedVaultPath(path: string): boolean {
  return path === MOUNTED_VAULT_ROOT || path.startsWith(`${MOUNTED_VAULT_ROOT}/`);
}

function hasMountedVaultMetadata(): boolean {
  return getStorage().getItem(MOUNTED_VAULT_META_KEY) !== null;
}

function setMountedVaultMetadata(name: string): void {
  try {
    getStorage().setItem(
      MOUNTED_VAULT_META_KEY,
      JSON.stringify({ path: MOUNTED_VAULT_ROOT, name })
    );
  } catch {
    // ignore storage failures for non-critical mount metadata
  }
}

function clearMountedVaultMetadata(): void {
  try {
    getStorage().removeItem(MOUNTED_VAULT_META_KEY);
  } catch {
    // ignore storage failures for non-critical mount metadata
  }
}

function canUseIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

async function openMountedVaultDb(): Promise<IDBDatabase | null> {
  if (!canUseIndexedDb()) {
    return null;
  }

  return await new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = indexedDB.open(MOUNTED_VAULT_DB, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(MOUNTED_VAULT_STORE)) {
        database.createObjectStore(MOUNTED_VAULT_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveMountedVaultHandle(handle: DirectoryHandleLike): Promise<void> {
  const database = await openMountedVaultDb();
  if (!database) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(MOUNTED_VAULT_STORE, "readwrite");
    const store = transaction.objectStore(MOUNTED_VAULT_STORE);
    const request = store.put(handle, MOUNTED_VAULT_HANDLE_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }).finally(() => {
    database.close();
  });
}

async function loadMountedVaultHandleFromDb(): Promise<DirectoryHandleLike | null> {
  const database = await openMountedVaultDb();
  if (!database) {
    return null;
  }

  return await new Promise<DirectoryHandleLike | null>((resolve, reject) => {
    const transaction = database.transaction(MOUNTED_VAULT_STORE, "readonly");
    const store = transaction.objectStore(MOUNTED_VAULT_STORE);
    const request = store.get(MOUNTED_VAULT_HANDLE_KEY);
    request.onsuccess = () => resolve((request.result as DirectoryHandleLike | undefined) ?? null);
    request.onerror = () => reject(request.error);
  }).finally(() => {
    database.close();
  });
}

async function clearMountedVaultHandleFromDb(): Promise<void> {
  const database = await openMountedVaultDb();
  if (!database) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(MOUNTED_VAULT_STORE, "readwrite");
    const store = transaction.objectStore(MOUNTED_VAULT_STORE);
    const request = store.delete(MOUNTED_VAULT_HANDLE_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }).finally(() => {
    database.close();
  });
}

function isNotFoundError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "NotFoundError";
  }
  if (error instanceof Error) {
    return /not found/i.test(error.message);
  }
  return false;
}

function isTypeMismatchError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TypeMismatchError";
}

async function getPermissionState(
  handle: FileHandleLike | DirectoryHandleLike,
  mode: PermissionMode
): Promise<PermissionStateLike> {
  if (!handle.queryPermission) {
    return "granted";
  }
  try {
    return await handle.queryPermission({ mode });
  } catch {
    return "granted";
  }
}

async function requestPermission(
  handle: FileHandleLike | DirectoryHandleLike,
  mode: PermissionMode
): Promise<PermissionStateLike> {
  if (!handle.requestPermission) {
    return "granted";
  }
  try {
    return await handle.requestPermission({ mode });
  } catch {
    return "denied";
  }
}

async function maybeGetMountedVaultHandle(): Promise<DirectoryHandleLike | null> {
  if (mountedVaultHandleCache !== undefined) {
    return mountedVaultHandleCache;
  }

  if (!hasMountedVaultMetadata()) {
    mountedVaultHandleCache = null;
    return null;
  }

  try {
    const handle = await loadMountedVaultHandleFromDb();
    if (!handle) {
      clearMountedVaultMetadata();
      mountedVaultHandleCache = null;
      return null;
    }

    const permission = await getPermissionState(handle, "readwrite");
    if (permission === "denied") {
      clearMountedVaultMetadata();
      void clearMountedVaultHandleFromDb().catch(() => undefined);
      mountedVaultHandleCache = null;
      return null;
    }

    mountedVaultHandleCache = handle;
    return handle;
  } catch {
    clearMountedVaultMetadata();
    mountedVaultHandleCache = null;
    return null;
  }
}

async function ensureMountedVaultHandle(
  mode: PermissionMode,
  allowPrompt: boolean
): Promise<DirectoryHandleLike | null> {
  const handle = await maybeGetMountedVaultHandle();
  if (!handle) {
    return null;
  }

  const permission = await getPermissionState(handle, mode);
  if (permission === "granted") {
    return handle;
  }
  if (permission === "denied") {
    clearMountedVaultMetadata();
    mountedVaultHandleCache = null;
    void clearMountedVaultHandleFromDb().catch(() => undefined);
    return null;
  }
  if (!allowPrompt) {
    return handle;
  }

  const requested = await requestPermission(handle, mode);
  if (requested === "granted") {
    return handle;
  }

  throw new Error("Browser denied access to the selected vault folder.");
}

function relativeMountSegments(path: string): string[] {
  if (path === MOUNTED_VAULT_ROOT) {
    return [];
  }
  return path
    .slice(MOUNTED_VAULT_ROOT.length)
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean);
}

async function getMountedDirectoryHandle(
  root: DirectoryHandleLike,
  segments: string[],
  create = false
): Promise<DirectoryHandleLike> {
  let current = root;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create });
  }
  return current;
}

async function getMountedEntryHandle(
  root: DirectoryHandleLike,
  path: string
): Promise<FileSystemHandleLike> {
  const segments = relativeMountSegments(path);
  if (segments.length === 0) {
    return root;
  }

  const parent = await getMountedDirectoryHandle(root, segments.slice(0, -1), false);
  const name = segments[segments.length - 1];

  try {
    return await parent.getFileHandle(name);
  } catch (error) {
    if (!isNotFoundError(error) && !isTypeMismatchError(error)) {
      throw error;
    }
  }

  return await parent.getDirectoryHandle(name);
}

async function getMountedParentHandle(
  root: DirectoryHandleLike,
  path: string,
  create = false
): Promise<{ parent: DirectoryHandleLike; name: string }> {
  const segments = relativeMountSegments(path);
  if (segments.length === 0) {
    throw new Error("Cannot operate on mounted vault root directly.");
  }
  const parent = await getMountedDirectoryHandle(root, segments.slice(0, -1), create);
  return {
    parent,
    name: segments[segments.length - 1]
  };
}

async function* iterateMountedEntries(
  directory: DirectoryHandleLike
): AsyncGenerator<[string, FileSystemHandleLike], void, void> {
  if (directory.entries) {
    for await (const entry of directory.entries()) {
      yield entry;
    }
    return;
  }

  if (directory.values) {
    for await (const handle of directory.values()) {
      yield [handle.name, handle];
    }
    return;
  }

  throw new Error("Directory iteration is unavailable in this browser.");
}

function toUint8Array(
  data: string | ArrayBuffer | Uint8Array | ArrayBufferView | Blob
): Promise<Uint8Array> | Uint8Array {
  if (typeof data === "string") {
    return encoder.encode(data);
  }
  if (data instanceof Uint8Array) {
    return new Uint8Array(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data.slice(0));
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    );
  }
  return data.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

async function writeMountedBytes(
  root: DirectoryHandleLike,
  path: string,
  data: Uint8Array
): Promise<void> {
  const { parent, name } = await getMountedParentHandle(root, path, true);
  const fileHandle = await parent.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function copyMountedEntry(
  root: DirectoryHandleLike,
  sourcePath: string,
  targetPath: string
): Promise<void> {
  const source = await getMountedEntryHandle(root, sourcePath);
  if (source.kind === "file") {
    const file = await source.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    await writeMountedBytes(root, targetPath, bytes);
    return;
  }

  await mkdir(targetPath);
  for await (const [name] of iterateMountedEntries(source)) {
    await copyMountedEntry(root, `${sourcePath}/${name}`, `${targetPath}/${name}`);
  }
}

async function listMountedDir(path: string): Promise<FileEntry[]> {
  const root = await ensureMountedVaultHandle("read", false);
  if (!root || !isMountedVaultPath(path)) {
    throw new Error(`Mounted path unavailable: ${path}`);
  }

  const entry = await getMountedEntryHandle(root, path);
  if (entry.kind !== "directory") {
    return [];
  }

  const results: FileEntry[] = [];
  for await (const [name, child] of iterateMountedEntries(entry)) {
    const childPath = normalizePath(`${path}/${name}`);
    if (child.kind === "directory") {
      results.push({
        path: childPath,
        name,
        isFile: false,
        isDirectory: true,
        isSymlink: false,
        children: []
      });
    } else {
      results.push({
        path: childPath,
        name,
        isFile: true,
        isDirectory: false,
        isSymlink: false
      });
    }
  }

  return results;
}

export async function registerMountedVaultDirectory(
  handle: DirectoryHandleLike
): Promise<string> {
  const initialPermission = await getPermissionState(handle, "readwrite");
  if (initialPermission === "denied") {
    throw new Error("Browser denied access to the selected vault folder.");
  }
  if (initialPermission === "prompt") {
    const requested = await requestPermission(handle, "readwrite");
    if (requested !== "granted") {
      throw new Error("Browser denied access to the selected vault folder.");
    }
  }

  mountedVaultHandleCache = handle;
  setMountedVaultMetadata(handle.name || "vault");
  await saveMountedVaultHandle(handle);
  return MOUNTED_VAULT_ROOT;
}

async function tryMountedVaultPath(path: string, mode: PermissionMode): Promise<DirectoryHandleLike | null> {
  if (!isMountedVaultPath(path)) {
    return null;
  }
  return ensureMountedVaultHandle(mode, mode === "readwrite");
}

export async function exists(path: string | URL, options?: BaseDirOptions): Promise<boolean> {
  const normalized = resolvePath(path, options);
  if (getRemoteHostConfig()) {
    const result = await remoteFs<{ exists: boolean }>("exists", {
      path: normalized,
      options: options ?? null
    });
    return Boolean(result.exists);
  }
  const mountedRoot = await tryMountedVaultPath(normalized, "read");
  if (mountedRoot) {
    try {
      await getMountedEntryHandle(mountedRoot, normalized);
      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  return fsState.files.has(normalized) || fsState.directories.has(normalized);
}

export async function mkdir(
  path: string | URL,
  options?: RecursiveOptions & BaseDirOptions
): Promise<void> {
  const normalized = resolvePath(path, options);
  if (getRemoteHostConfig()) {
    await remoteFs<void>("mkdir", {
      path: normalized,
      options: options ?? null
    });
    return;
  }
  const mountedRoot = await tryMountedVaultPath(normalized, "readwrite");
  if (mountedRoot) {
    if (normalized === MOUNTED_VAULT_ROOT) {
      return;
    }
    const segments = relativeMountSegments(normalized);
    await getMountedDirectoryHandle(mountedRoot, segments, true);
    return;
  }

  ensureVirtualDir(normalized);
  persistVirtualState();
}

export async function readTextFile(path: string | URL, options?: BaseDirOptions): Promise<string> {
  const normalized = resolvePath(path, options);
  if (getRemoteHostConfig()) {
    const result = await remoteFs<{ content: string }>("read-text", {
      path: normalized,
      options: options ?? null
    });
    return typeof result.content === "string" ? result.content : "";
  }
  const mountedRoot = await tryMountedVaultPath(normalized, "read");
  if (mountedRoot) {
    const entry = await getMountedEntryHandle(mountedRoot, normalized);
    if (entry.kind !== "file") {
      throw new Error(`File not found: ${normalized}`);
    }
    return (await entry.getFile()).text();
  }

  const data = fsState.files.get(normalized);
  if (!data) throw new Error(`File not found: ${normalized}`);
  return decoder.decode(data);
}

export async function readTextFiles(paths: string[]): Promise<string[]> {
  if (!getRemoteHostConfig()) {
    return Promise.all(paths.map((path) => readTextFile(path)));
  }
  const result = await remoteFs<{ files: Array<{ path: string; content: string }> }>(
    "read-text-batch",
    { paths }
  );
  if (!Array.isArray(result.files) || result.files.length !== paths.length) {
    throw new Error("Remote text batch returned an invalid file count.");
  }
  return result.files.map((file, index) => {
    if (file?.path !== paths[index] || typeof file.content !== "string") {
      throw new Error(`Remote text batch returned an invalid entry at index ${index}.`);
    }
    return file.content;
  });
}

export async function writeTextFile(
  path: string | URL,
  contents: string,
  options?: BaseDirOptions
): Promise<void> {
  const normalized = resolvePath(path, options);
  if (getRemoteHostConfig()) {
    await remoteFs<void>("write-text", {
      path: normalized,
      content: contents,
      options: options ?? null
    });
    return;
  }
  const mountedRoot = await tryMountedVaultPath(normalized, "readwrite");
  if (mountedRoot) {
    await writeMountedBytes(mountedRoot, normalized, encoder.encode(contents));
    return;
  }

  ensureVirtualDir(getParent(normalized));
  fsState.files.set(normalized, encoder.encode(contents));
  persistVirtualState();
}

export async function readFile(path: string | URL, options?: BaseDirOptions): Promise<Uint8Array> {
  const normalized = resolvePath(path, options);
  if (getRemoteHostConfig()) {
    const result = await remoteFs<{ dataBase64: string }>("read-file", {
      path: normalized,
      options: options ?? null
    });
    return decodeRemoteBase64(result.dataBase64);
  }
  const mountedRoot = await tryMountedVaultPath(normalized, "read");
  if (mountedRoot) {
    const entry = await getMountedEntryHandle(mountedRoot, normalized);
    if (entry.kind !== "file") {
      throw new Error(`File not found: ${normalized}`);
    }
    const file = await entry.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  const data = fsState.files.get(normalized);
  if (!data) throw new Error(`File not found: ${normalized}`);
  return new Uint8Array(data);
}

export async function writeFile(
  path: string | URL,
  contents: Uint8Array,
  options?: BaseDirOptions
): Promise<void> {
  const normalized = resolvePath(path, options);
  if (getRemoteHostConfig()) {
    await remoteFs<void>("write-file", {
      path: normalized,
      dataBase64: encodeRemoteBase64(contents),
      options: options ?? null
    });
    return;
  }
  const mountedRoot = await tryMountedVaultPath(normalized, "readwrite");
  if (mountedRoot) {
    await writeMountedBytes(mountedRoot, normalized, new Uint8Array(contents));
    return;
  }

  ensureVirtualDir(getParent(normalized));
  fsState.files.set(normalized, new Uint8Array(contents));
  persistVirtualState();
}

export async function readDir(
  path: string | URL,
  options?: RecursiveOptions & BaseDirOptions
): Promise<RecursiveDirEntry[]> {
  const normalized = resolvePath(path, options);
  if (getRemoteHostConfig()) {
    const result = await remoteFs<{ entries: FileEntry[] }>("read-dir", {
      path: normalized,
      options: options ?? null
    });
    return Array.isArray(result.entries)
      ? result.entries.map(function toRecursiveDirEntry(
          { path: _path, children, mtime, ...entry }: FileEntry
        ): RecursiveDirEntry {
          return {
            ...entry,
            mtime: typeof mtime === "string" ? new Date(mtime) : mtime,
            ...(children ? { children: children.map(toRecursiveDirEntry) } : {})
          };
        })
      : [];
  }
  const mountedRoot = await tryMountedVaultPath(normalized, "read");
  if (mountedRoot) {
    return (await listMountedDir(normalized)).map(({ path: _path, children: _children, ...entry }) => entry);
  }

  if (!fsState.directories.has(normalized)) return [];
  return listVirtualChildren(normalized).map(({ path: _path, children: _children, ...entry }) => entry);
}

export async function remove(
  path: string | URL,
  options?: { recursive?: boolean; baseDir?: BaseDirectory }
): Promise<void> {
  const normalized = resolvePath(path, options);
  if (getRemoteHostConfig()) {
    await remoteFs<void>("remove", {
      path: normalized,
      options: options ?? null
    });
    return;
  }
  const mountedRoot = await tryMountedVaultPath(normalized, "readwrite");
  if (mountedRoot) {
    if (normalized === MOUNTED_VAULT_ROOT) {
      throw new Error("Cannot remove the mounted vault root.");
    }
    const { parent, name } = await getMountedParentHandle(mountedRoot, normalized, false);
    if (!parent.removeEntry) {
      throw new Error("Directory removal is unavailable in this browser.");
    }
    await parent.removeEntry(name, { recursive: Boolean(options?.recursive) });
    return;
  }

  const hasChildren = [...fsState.directories].some(
    (dir) => dir.startsWith(`${normalized}/`)
  );
  if (hasChildren && !options?.recursive) {
    throw new Error(`Directory not empty: ${normalized}`);
  }
  for (const filePath of Array.from(fsState.files.keys())) {
    if (filePath === normalized || filePath.startsWith(`${normalized}/`)) {
      fsState.files.delete(filePath);
    }
  }
  for (const dir of Array.from(fsState.directories)) {
    if (dir === normalized || dir.startsWith(`${normalized}/`)) {
      fsState.directories.delete(dir);
    }
  }
  persistVirtualState();
}

export async function stat(path: string | URL, options?: BaseDirOptions): Promise<FileInfo> {
  const normalized = resolvePath(path, options);
  if (getRemoteHostConfig()) {
    const result = await remoteFs<{
      isFile: boolean;
      isDirectory: boolean;
      isSymlink: boolean;
      size: number;
      mtime: string | null;
    }>("stat", {
      path: normalized,
      options: options ?? null
    });
    return {
      isFile: Boolean(result.isFile),
      isDirectory: Boolean(result.isDirectory),
      isSymlink: Boolean(result.isSymlink),
      size: typeof result.size === "number" ? result.size : 0,
      mtime: typeof result.mtime === "string" ? new Date(result.mtime) : null
    };
  }
  const mountedRoot = await tryMountedVaultPath(normalized, "read");
  if (mountedRoot) {
    const entry = await getMountedEntryHandle(mountedRoot, normalized);
    if (entry.kind === "directory") {
      return {
        isFile: false,
        isDirectory: true,
        isSymlink: false,
        size: 0,
        mtime: null
      };
    }
    const file = await entry.getFile();
    return {
      isFile: true,
      isDirectory: false,
      isSymlink: false,
      size: file.size,
      mtime: typeof file.lastModified === "number" ? new Date(file.lastModified) : null
    };
  }

  const fileData = fsState.files.get(normalized);
  if (fileData) {
    return {
      isFile: true,
      isDirectory: false,
      isSymlink: false,
      size: fileData.length,
      mtime: new Date()
    };
  }
  if (fsState.directories.has(normalized)) {
    return {
      isFile: false,
      isDirectory: true,
      isSymlink: false,
      size: 0,
      mtime: new Date()
    };
  }
  throw new Error(`Path not found: ${normalized}`);
}

export async function rename(
  oldPath: string | URL,
  newPath: string | URL,
  options?: BaseDirOptions
): Promise<void> {
  const oldNormalized = resolvePath(oldPath, options);
  const newNormalized = resolvePath(newPath, options);
  if (getRemoteHostConfig()) {
    await remoteFs<void>("rename", {
      oldPath: oldNormalized,
      newPath: newNormalized,
      options: options ?? null
    });
    return;
  }
  const mountedRoot = await tryMountedVaultPath(oldNormalized, "readwrite");
  if (mountedRoot) {
    if (!isMountedVaultPath(newNormalized)) {
      throw new Error("Cross-filesystem moves are not supported in the web shim.");
    }
    await copyMountedEntry(mountedRoot, oldNormalized, newNormalized);
    await remove(oldNormalized, { recursive: true });
    return;
  }

  const data = fsState.files.get(oldNormalized);
  if (data) {
    ensureVirtualDir(getParent(newNormalized));
    fsState.files.set(newNormalized, data);
    fsState.files.delete(oldNormalized);
    persistVirtualState();
    return;
  }
  if (fsState.directories.has(oldNormalized)) {
    ensureVirtualDir(newNormalized);
    fsState.directories.delete(oldNormalized);
    for (const filePath of Array.from(fsState.files.keys())) {
      if (filePath.startsWith(`${oldNormalized}/`)) {
        const relative = filePath.slice(oldNormalized.length);
        fsState.files.set(`${newNormalized}${relative}`, fsState.files.get(filePath)!);
        fsState.files.delete(filePath);
      }
    }
    for (const dir of Array.from(fsState.directories)) {
      if (dir.startsWith(`${oldNormalized}/`)) {
        const relative = dir.slice(oldNormalized.length);
        fsState.directories.add(`${newNormalized}${relative}`);
        fsState.directories.delete(dir);
      }
    }
    persistVirtualState();
    return;
  }
  throw new Error(`Path not found: ${oldNormalized}`);
}
