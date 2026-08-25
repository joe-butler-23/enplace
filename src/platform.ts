import {
  readTextFile,
  writeTextFile,
  readFile,
  writeFile,
  mkdir,
  readDir,
  remove,
  rename,
  exists,
  stat
} from "@/host-client/fs";
import * as fsPlugin from "@/host-client/fs";
import { appDataDir, join } from "@/host-client/path";
// react-doctor-disable-next-line no-moment
import moment from "moment";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isHostedRuntime } from "@/runtime";
import { mepCookingBuildDesiredItems } from "@/host-client/commands";
import type {
  CookingDesiredItem,
  CookingRecipeInput
} from "@/host-client/commands";

export type EventRef = { event: string; id: number };

export type CookingCapabilities = {
  buildDesiredItems: (
    recipes: CookingRecipeInput[]
  ) => Promise<CookingDesiredItem[]>;
};

declare global {
  interface HTMLElement {
    createEl: (tag: string, options?: { text?: string; cls?: string }) => HTMLElement;
    empty: () => void;
  }
}

type EventArguments<Events, Key extends keyof Events> = Events[Key] extends readonly unknown[]
  ? Events[Key]
  : never;

class EventEmitter<Events extends object> {
  private listeners = new Map<keyof Events, Map<number, (...args: never[]) => void>>();
  private nextId = 1;

  on<Key extends keyof Events & string>(
    event: Key,
    callback: (...args: EventArguments<Events, Key>) => void
  ): EventRef {
    const id = this.nextId++;
    const bucket = this.listeners.get(event) ?? new Map<number, (...args: never[]) => void>();
    bucket.set(id, callback as (...args: never[]) => void);
    this.listeners.set(event, bucket);
    return { event, id };
  }

  offref(ref: EventRef) {
    this.listeners.get(ref.event as keyof Events)?.delete(ref.id);
  }

  trigger<Key extends keyof Events & string>(event: Key, ...args: EventArguments<Events, Key>) {
    this.listeners.get(event)?.forEach((listener) => listener(...(args as never[])));
  }
}

function ensureElementHelpers(): void {
  if (!HTMLElement.prototype.createEl) {
    HTMLElement.prototype.createEl = function (
      tag: string,
      options?: { text?: string; cls?: string }
    ) {
      const el = document.createElement(tag);
      if (options?.text) {
        el.textContent = options.text;
      }
      if (options?.cls) {
        el.className = options.cls;
      }
      this.appendChild(el);
      return el;
    };
  }
  if (!HTMLElement.prototype.empty) {
    HTMLElement.prototype.empty = function () {
      while (this.firstChild) {
        this.removeChild(this.firstChild);
      }
    };
  }
}

export class TAbstractFile {
  constructor(public path: string, public name: string) {}
}

export class TFile extends TAbstractFile {
  extension: string;
  basename: string;
  absolutePath: string;
  stat: { mtime: number; size: number };

  constructor(path: string, name: string, absolutePath: string, statInfo: { mtime: number; size: number }) {
    super(path, name);
    const parts = name.split(".");
    this.extension = parts.length > 1 ? parts.pop() ?? "" : "";
    this.basename = parts.join(".");
    this.absolutePath = absolutePath;
    this.stat = statInfo;
  }
}

export class TFolder extends TAbstractFile {
  absolutePath: string;
  children: TAbstractFile[] = [];
  constructor(path: string, name: string, absolutePath: string) {
    super(path, name);
    this.absolutePath = absolutePath;
  }
}

type VaultEvents = {
  create: [file: TAbstractFile];
  modify: [file: TAbstractFile];
  delete: [file: TAbstractFile];
  rename: [file: TAbstractFile, oldPath: string];
};

type MetadataCacheEvents = {
  changed: [file: TAbstractFile | string];
};

export type CachedMetadata = {
  frontmatter?: Record<string, unknown>;
  tags?: string[];
};

export function getAllTags(cache: CachedMetadata): string[] | null {
  if (!cache) return null;
  const tags = cache.tags ?? [];
  return tags.length ? tags : null;
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "");
}

type FsEntry = {
  path: string;
  name: string;
  size?: number;
  mtime?: Date | number | null;
  children?: FsEntry[];
};

type RecursiveReadDirEntry = {
  name: string;
  isDirectory: boolean;
  size?: number;
  mtime?: Date | number | null;
  children?: RecursiveReadDirEntry[];
};

type FsPluginWithBatchRead = {
  readTextFiles?: (paths: string[]) => Promise<string[]>;
};

// Matches the web host's maximum `/fs/read-text-batch` path count.
const MAX_TEXT_READ_BATCH_PATHS = 4_096;

async function readRequiredTextFiles(paths: string[]): Promise<string[]> {
  const batchRead = (fsPlugin as unknown as FsPluginWithBatchRead).readTextFiles;
  if (typeof batchRead !== "function") {
    return Promise.all(paths.map((path) => readTextFile(path)));
  }

  const contents: string[] = [];
  for (let offset = 0; offset < paths.length; offset += MAX_TEXT_READ_BATCH_PATHS) {
    contents.push(...await batchRead(paths.slice(offset, offset + MAX_TEXT_READ_BATCH_PATHS)));
  }
  return contents;
}

type VaultAdapter = {
  getBasePath: () => string;
  exists: (path: string) => Promise<boolean>;
  read: (path: string) => Promise<string>;
  write: (path: string, data: string) => Promise<void>;
  append: (path: string, data: string) => Promise<void>;
  list: (path: string) => Promise<FsEntry[]>;
	remove: (path: string) => Promise<void>;
	rename: (from: string, to: string) => Promise<void>;
	mkdir: (path: string) => Promise<void>;
};

const INDEXED_HIDDEN_ENTRIES = new Set([".machine"]);

function shouldIndexDirEntry(name: string): boolean {
  if (!name.startsWith(".")) return true;
  return INDEXED_HIDDEN_ENTRIES.has(name);
}

async function readDirRecursive(
  root: string,
  listedEntries?: RecursiveReadDirEntry[]
): Promise<FsEntry[]> {
  const entries = listedEntries ?? await readDir(root, {
    recursive: true
  } as unknown as Parameters<typeof readDir>[1]) as RecursiveReadDirEntry[];
  return Promise.all(entries.flatMap((entry) => {
    if (!shouldIndexDirEntry(entry.name)) return [];
    return [
      (async () => {
        const entryPath = await join(root, entry.name);
        if (entry.isDirectory) {
          return {
            path: entryPath,
            name: entry.name,
            children: await readDirRecursive(entryPath, entry.children)
          };
        }
        return {
          path: entryPath,
          name: entry.name,
          size: entry.size,
          mtime: entry.mtime
        };
      })()
    ];
  }));
}

function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  if (!raw.startsWith("---")) {
    return { frontmatter: {}, body: raw };
  }

  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: raw };
  }

  const frontmatterBlock = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, "");
  const parsed = parseYaml(frontmatterBlock) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { frontmatter: {}, body };
  }
  return { frontmatter: parsed as Record<string, unknown>, body };
}

function serializeFrontmatter(frontmatter: Record<string, unknown>): string {
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---`;
}

function composeFrontmatterDocument(
  frontmatter: Record<string, unknown>,
  bodyRaw: string
): string {
  const frontmatterBlock = serializeFrontmatter(frontmatter);
  const normalizedBody = (bodyRaw ?? "")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  if (!normalizedBody) {
    return `${frontmatterBlock}\n`;
  }
  return `${frontmatterBlock}\n\n${normalizedBody}\n`;
}

function extractTags(frontmatter: Record<string, unknown>, body: string): string[] {
  const tags = new Set<string>();
  const fmTags = frontmatter.tags;
  if (Array.isArray(fmTags)) {
    fmTags.forEach((tag) => {
      if (typeof tag === "string" && tag.trim()) {
        tags.add(tag.startsWith("#") ? tag : `#${tag}`);
      }
    });
  } else if (typeof fmTags === "string" && fmTags.trim()) {
    fmTags
      .split(/[,\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .forEach((tag) => tags.add(tag.startsWith("#") ? tag : `#${tag}`));
  }

  const bodyTags = body.match(/#[A-Za-z0-9/_-]+/g) ?? [];
  bodyTags.forEach((tag) => tags.add(tag));
  return Array.from(tags);
}

const frontmatterUpdateChains = new Map<string, Promise<unknown>>();

export function createCookingCapabilities(): CookingCapabilities {
  return {
    async buildDesiredItems(recipes) {
      if (!isHostedRuntime()) {
        throw new Error(
          "Deterministic cooking aggregation requires the web host runtime."
        );
      }
      return mepCookingBuildDesiredItems({ recipes });
    }
  };
}

export class MetadataCache extends EventEmitter<MetadataCacheEvents> {
  private cache = new Map<string, CachedMetadata>();
  private verifiedVersions = new Map<string, string>();

  constructor(private vault: Vault) {
    super();
  }

  updateFile(file: TFile, content: string): void {
    this.updateFiles([file], [content]);
  }

  updateFiles(files: readonly TFile[], contents: readonly string[]): void {
    if (files.length !== contents.length) {
      throw new Error("Metadata hydration returned an incomplete content set.");
    }

    // Parse and compare the complete batch before publishing any entry. A malformed file must not
    // leave a partially hydrated planner cache that looks ready to consumers.
    const updates = files.map((file, index) => {
      const { frontmatter, body } = parseFrontmatter(contents[index]);
      const metadata = { frontmatter, tags: extractTags(frontmatter, body) };
      const previous = this.cache.get(file.path);
      return {
        file,
        metadata,
        version: `${file.stat.mtime}:${file.stat.size}`,
        changed:
          JSON.stringify(previous?.frontmatter ?? null) !== JSON.stringify(metadata.frontmatter) ||
          JSON.stringify(previous?.tags ?? null) !== JSON.stringify(metadata.tags)
      };
    });

    for (const update of updates) {
      this.verifiedVersions.set(update.file.path, update.version);
      if (!update.changed) continue;
      this.cache.set(update.file.path, update.metadata);
      this.trigger("changed", update.file);
    }
  }

  isCurrent(file: TFile): boolean {
    return this.verifiedVersions.get(file.path) === `${file.stat.mtime}:${file.stat.size}`;
  }

  clearFile(path: string): void {
    this.cache.delete(path);
    this.verifiedVersions.delete(path);
    this.trigger("changed", path);
  }

  getFileCache(file: TFile): CachedMetadata | null {
    return this.cache.get(file.path) ?? null;
  }

  // Seeds normal (non-direct-database) startup from the previous session without claiming that
  // data is current: hydrate never sets verifiedVersions, so the authoritative Markdown read still
  // runs and gates Planner readiness. Direct database startup skips this synchronous JSON parse.
  hydrate(entries: Record<string, CachedMetadata>) {
    for (const [path, meta] of Object.entries(entries)) {
      if (!this.cache.has(path)) this.cache.set(path, meta);
    }
  }

  snapshot(): Record<string, CachedMetadata> {
    return Object.fromEntries(this.cache);
  }

  getFirstLinkpathDest(linkPath: string, sourcePath: string): TFile | null {
    const normalized = normalizePath(linkPath);
    const candidates = [normalized, normalizePath(`${sourcePath.split("/").slice(0, -1).join("/")}/${normalized}`)];
    for (const candidate of candidates) {
      const cached = this.vault.getAbstractFileByPath(candidate);
      if (cached instanceof TFile) return cached;
    }
    return null;
  }
}

export class FileManager {
  constructor(private app: App) {}

  async processFrontMatter(
    file: TFile,
    updater: (frontmatter: Record<string, unknown>) => void
  ) {
    const vault = this.app?.vault;
    const metadataCache = this.app?.metadataCache;
    if (!vault || !metadataCache) return;
    const doWrite = async () => {
      const content = await vault.read(file);
      const parsed = parseFrontmatter(content);
      const frontmatter = { ...parsed.frontmatter };
      updater(frontmatter);
      const next = composeFrontmatterDocument(frontmatter, parsed.body ?? "");
      await vault.modify(file, next);
    };
    const prev = frontmatterUpdateChains.get(file.absolutePath) ?? Promise.resolve();
    const next = prev.then(doWrite, doWrite);
    frontmatterUpdateChains.set(file.absolutePath, next);
    next.then(
      () => {
        if (frontmatterUpdateChains.get(file.absolutePath) === next) {
          frontmatterUpdateChains.delete(file.absolutePath);
        }
      },
      () => {
        if (frontmatterUpdateChains.get(file.absolutePath) === next) {
          frontmatterUpdateChains.delete(file.absolutePath);
        }
      }
    );
    return next;
  }

  async renameFile(file: TFile, newPath: string): Promise<void> {
    await this.app.vault.rename(file, newPath);
  }
}

export type FolderMetadataHydration = {
  hydrateMetadata: (signal?: AbortSignal) => Promise<void>;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException("Metadata hydration was cancelled.", "AbortError");
}

export class Vault extends EventEmitter<VaultEvents> {
  private files: TFile[] = [];
  private folders: TFolder[] = [];
  private filesByPath = new Map<string, TFile>();
  private foldersByPath = new Map<string, TFolder>();
  private adapterCache: VaultAdapter | null = null;
  private indexGeneration = 0;
  configDir = ".mep";

  readonly metadataCache: MetadataCache;

  constructor(public rootPath: string) {
    super();
    this.metadataCache = new MetadataCache(this);
  }

  private advanceIndexGeneration(): number {
    this.indexGeneration += 1;
    return this.indexGeneration;
  }

  get adapter(): VaultAdapter {
    if (this.adapterCache) return this.adapterCache;
    this.adapterCache = {
      getBasePath: () => this.rootPath,
      exists: async (path: string) => exists(await this.resolveAbsolute(path)),
      read: async (path: string) => readTextFile(await this.resolveAbsolute(path)),
      write: async (path: string, data: string) => writeTextFile(await this.resolveAbsolute(path), data),
      append: async (path: string, data: string) => {
        const absolute = await this.resolveAbsolute(path);
        const current = (await exists(absolute)) ? await readTextFile(absolute) : "";
        await writeTextFile(absolute, current + data);
      },
      list: async (path: string) => readDirRecursive(await this.resolveAbsolute(path)),
      remove: async (path: string) => remove(await this.resolveAbsolute(path)),
      rename: async (from: string, to: string) =>
        rename(await this.resolveAbsolute(from), await this.resolveAbsolute(to)),
      mkdir: async (path: string) => mkdir(await this.resolveAbsolute(path), { recursive: true })
    };
    return this.adapterCache;
  }

  private async resolveAbsolute(path: string): Promise<string> {
    const normalized = normalizePath(path);
    return join(this.rootPath, normalized);
  }

  private rebuildIndexes() {
    this.filesByPath.clear();
    this.foldersByPath.clear();
    for (const file of this.files) {
      this.filesByPath.set(file.path, file);
    }
    for (const folder of this.folders) {
      this.foldersByPath.set(folder.path, folder);
    }
  }

  private async ensureFolderIndexed(path: string): Promise<void> {
    const normalized = normalizePath(path).replace(/\/+$/, "");
    if (!normalized) return;
    if (this.foldersByPath.has(normalized)) return;

    const parentPath = normalized.includes("/")
      ? normalized.split("/").slice(0, -1).join("/")
      : "";
    if (parentPath) {
      await this.ensureFolderIndexed(parentPath);
    }

    const folderName = normalized.split("/").pop() ?? normalized;
    const absolutePath = await this.resolveAbsolute(normalized);
    const folder = new TFolder(normalized, folderName, absolutePath);
    this.advanceIndexGeneration();
    this.foldersByPath.set(normalized, folder);
    this.folders.push(folder);

    if (parentPath) {
      const parent = this.foldersByPath.get(parentPath);
      if (parent && !parent.children.some((child) => child.path === normalized)) {
        parent.children.push(folder);
      }
    }
  }

  private parentFolderPath(path: string): string {
    const normalized = normalizePath(path).replace(/\/+$/, "");
    if (!normalized.includes("/")) return "";
    return normalized.split("/").slice(0, -1).join("/");
  }

  private unlinkFromParent(path: string): void {
    const parentPath = this.parentFolderPath(path);
    if (!parentPath) return;
    const parent = this.foldersByPath.get(parentPath);
    if (!parent) return;
    parent.children = parent.children.filter((child) => child.path !== path);
  }

  private linkFileToParent(file: TFile): void {
    const parentPath = this.parentFolderPath(file.path);
    if (!parentPath) return;
    const parent = this.foldersByPath.get(parentPath);
    if (!parent) return;
    const index = parent.children.findIndex((child) => child.path === file.path);
    if (index >= 0) {
      parent.children[index] = file;
      return;
    }
    parent.children.push(file);
  }

  private relativeFromAbsolute(absolutePath: string): string | null {
    const normalizedAbsolute = absolutePath.replace(/\\/g, "/");
    const normalizedRoot = this.rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalizedAbsolute === normalizedRoot) {
      return "";
    }
    const rootPrefix = `${normalizedRoot}/`;
    if (!normalizedAbsolute.startsWith(rootPrefix)) {
      return null;
    }
    const relative = normalizedAbsolute.slice(rootPrefix.length).replace(/^\/+/, "");
    return normalizePath(relative);
  }

  private async collectIndexedEntries(entries: FsEntry[], basePath = ""): Promise<{
    files: TFile[];
    folders: TFolder[];
  }> {
    const files: TFile[] = [];
    const folders: TFolder[] = [];
    const folderMap = new Map<string, TFolder>();

    const walk = async (items: FsEntry[], currentBasePath = "") => {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const name = item.name ?? "";
        const relative = normalizePath(currentBasePath ? `${currentBasePath}/${name}` : name);
        const parent = currentBasePath ? folderMap.get(normalizePath(currentBasePath)) : undefined;
        if (item.children) {
          const folder = new TFolder(relative, name, await this.resolveAbsolute(relative));
          folderMap.set(relative, folder);
          folders.push(folder);
          if (parent) {
            parent.children.push(folder);
          }
          await walk(item.children, relative);
        } else if (item.path) {
          const fileItems: FsEntry[] = [];
          while (
            index + fileItems.length < items.length &&
            fileItems.length < 16 &&
            !items[index + fileItems.length].children
          ) {
            fileItems.push(items[index + fileItems.length]);
          }
          const fileResults = await Promise.all(
            fileItems.map(async (fileItem) => {
              try {
                const fileName = fileItem.name ?? "";
                const fileRelative = normalizePath(
                  currentBasePath ? `${currentBasePath}/${fileName}` : fileName
                );
                const info = typeof fileItem.size === "number" && fileItem.mtime != null
                  ? fileItem
                  : await stat(fileItem.path);
                const mtime =
                  typeof info.mtime === "number"
                    ? info.mtime
                    : Number(info.mtime ?? 0);
                return new TFile(fileRelative, fileName, fileItem.path, {
                  mtime,
                  size: info.size ?? 0
                });
              } catch {
                return null;
              }
            })
          );
          for (const file of fileResults) {
            if (!file) continue;
            files.push(file);
            const fileParent = currentBasePath ? folderMap.get(normalizePath(currentBasePath)) : undefined;
            if (fileParent) {
              fileParent.children.push(file);
            }
          }
          index += fileItems.length - 1;
        }
      }
    };

    await walk(entries, normalizePath(basePath));
    return { files, folders };
  }

  async indexFolder(path: string): Promise<FolderMetadataHydration> {
    const normalized = normalizePath(path).replace(/\/+$/, "");
    if (!normalized) {
      return {
        hydrateMetadata: async (signal?: AbortSignal) => {
          throwIfAborted(signal);
        }
      };
    }
    const parentPath = this.parentFolderPath(normalized);
    await this.ensureFolderIndexed(parentPath);
    const indexedGeneration = this.advanceIndexGeneration();
    const absoluteRoot = await this.resolveAbsolute(normalized);
    const entries = await readDirRecursive(absoluteRoot);
    const rootFolder = new TFolder(
      normalized,
      normalized.split("/").pop() ?? normalized,
      absoluteRoot
    );
    const { files, folders } = await this.collectIndexedEntries(entries, normalized);
    if (this.indexGeneration !== indexedGeneration) {
      throw new Error("Folder indexing was superseded by a newer vault operation.");
    }

    const previousFolderFiles = this.files.filter(
      (file) => file.path.startsWith(`${normalized}/`)
    );
    const indexedPaths = new Set(files.map((file) => file.path));
    this.files = this.files.filter((file) => !file.path.startsWith(`${normalized}/`));
    this.folders = this.folders.filter(
      (folder) => folder.path !== normalized && !folder.path.startsWith(`${normalized}/`)
    );
    this.unlinkFromParent(normalized);
    rootFolder.children = [
      ...folders.filter((folder) => this.parentFolderPath(folder.path) === normalized),
      ...files.filter((file) => this.parentFolderPath(file.path) === normalized)
    ];
    this.folders.push(rootFolder, ...folders);
    this.files.push(...files);
    this.rebuildIndexes();
    for (const previousFile of previousFolderFiles) {
      if (!indexedPaths.has(previousFile.path)) {
        this.metadataCache.clearFile(previousFile.path);
      }
    }
    if (parentPath) {
      const parent = this.foldersByPath.get(parentPath);
      if (parent) parent.children.push(rootFolder);
    }

    return {
      hydrateMetadata: async (signal?: AbortSignal) => {
        throwIfAborted(signal);
        if (this.indexGeneration !== indexedGeneration) {
          throw new Error("Folder metadata hydration was superseded by a newer vault index.");
        }
        const changedFiles = files.filter(
          (file) => file.extension === "md" && !this.metadataCache.isCurrent(file)
        );
        const contents = await readRequiredTextFiles(
          changedFiles.map((file) => file.absolutePath)
        );
        throwIfAborted(signal);
        if (this.indexGeneration !== indexedGeneration) {
          throw new Error("Folder metadata hydration was superseded by a newer vault index.");
        }
        this.metadataCache.updateFiles(changedFiles, contents);
      }
    };
  }

  async refreshFolder(path: string): Promise<void> {
    const indexed = await this.indexFolder(path);
    await indexed.hydrateMetadata();
  }

  // Returns whether this pass actually found anything new, so callers (e.g. the deferred boot-time
  // reindex in App.tsx) can skip signalling a vault-wide change when a full refresh lands right
  // after a folder-scoped refreshFolder has already indexed the same files -- otherwise a
  // no-op refresh still forces every vaultRevision-keyed view to redundantly refetch.
  async refresh(force = false): Promise<boolean> {
    const indexedGeneration = this.advanceIndexGeneration();
    const previousFilesByPath = new Map(this.filesByPath);
    const entries = await readDirRecursive(this.rootPath);
    const { files, folders } = await this.collectIndexedEntries(entries);
    if (this.indexGeneration !== indexedGeneration) {
      throw new Error("Vault indexing was superseded by a newer vault operation.");
    }

    this.files = files;
    this.folders = folders;
    this.rebuildIndexes();
    const indexedPaths = new Set(files.map((file) => file.path));
    for (const previousFile of previousFilesByPath.values()) {
      if (!indexedPaths.has(previousFile.path)) {
        this.metadataCache.clearFile(previousFile.path);
      }
    }
    const changedFiles = files.filter(
      (file) => file.extension === "md" && (force || !this.metadataCache.isCurrent(file))
    );
    const contents = await readRequiredTextFiles(changedFiles.map((file) => file.absolutePath));
    if (this.indexGeneration !== indexedGeneration) {
      throw new Error("Vault metadata refresh was superseded by a newer vault index.");
    }
    this.metadataCache.updateFiles(changedFiles, contents);
    return changedFiles.length > 0 || files.length !== previousFilesByPath.size;
  }

  getFiles(): TFile[] {
    return [...this.files];
  }

  getMarkdownFiles(): TFile[] {
    return this.files.filter((file) => file.extension === "md");
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    const normalized = normalizePath(path);
    return this.filesByPath.get(normalized) ??
      this.foldersByPath.get(normalized) ??
      null;
  }

  async read(file: TFile): Promise<string> {
    return readTextFile(file.absolutePath);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const bytes = await readFile(file.absolutePath);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }

  async create(path: string, content: string): Promise<TFile> {
    const normalized = normalizePath(path);
    if (this.getAbstractFileByPath(normalized)) {
      throw new Error("File already exists.");
    }

    return this.createOrOverwrite(normalized, content);
  }

  async createOrOverwrite(path: string, content: string): Promise<TFile> {
    const normalized = normalizePath(path);
    const absolute = await this.resolveAbsolute(normalized);
    const parentPath = normalized.includes("/")
      ? normalized.split("/").slice(0, -1).join("/")
      : "";
    if (parentPath) {
      await mkdir(await this.resolveAbsolute(parentPath), { recursive: true });
      await this.ensureFolderIndexed(parentPath);
    }
    await writeTextFile(absolute, content);
    const changed = await this.applyExternalChange({
      kind: "create",
      path: absolute
    });
    if (!changed) {
      throw new Error(`Failed to register created file: ${normalized}`);
    }
    const file = this.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      return file;
    }
    throw new Error(`Failed to create file: ${normalized}`);
  }

  async createBinary(path: string, content: ArrayBuffer): Promise<TFile> {
    const normalized = normalizePath(path);
    const absolute = await this.resolveAbsolute(normalized);
    const parentPath = normalized.includes("/")
      ? normalized.split("/").slice(0, -1).join("/")
      : "";
    if (parentPath) {
      await mkdir(await this.resolveAbsolute(parentPath), { recursive: true });
      await this.ensureFolderIndexed(parentPath);
    }
    await writeFile(absolute, new Uint8Array(content));
    const changed = await this.applyExternalChange({
      kind: "create",
      path: absolute
    });
    if (!changed) {
      throw new Error(`Failed to register created file: ${normalized}`);
    }
    const file = this.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      return file;
    }
    throw new Error(`Failed to create file: ${normalized}`);
  }

  async modify(file: TFile, content: string): Promise<void> {
    await writeTextFile(file.absolutePath, content);
    try {
      const info = await stat(file.absolutePath);
      const mtime =
        typeof info.mtime === "number"
          ? info.mtime
          : Number(info.mtime ?? file.stat.mtime);
      file.stat = {
        mtime,
        size: info.size ?? file.stat.size
      };
    } catch {
      // best-effort stat refresh
    }
    this.advanceIndexGeneration();
    this.metadataCache.updateFile(file, content);
    this.trigger("modify", file);
  }

  applyOptimisticContent(file: TFile, content: string): void {
    this.advanceIndexGeneration();
    this.metadataCache.updateFile(file, content);
    this.trigger("modify", file);
  }

  async createFolder(path: string): Promise<void> {
    const normalized = normalizePath(path).replace(/\/+$/, "");
    if (!normalized) return;
    await mkdir(await this.resolveAbsolute(normalized), { recursive: true });
    await this.ensureFolderIndexed(normalized);
  }

  async trash(file: TFile, _system = false): Promise<void> {
    await remove(file.absolutePath);
    await this.applyExternalChange({
      kind: "remove",
      path: file.absolutePath
    });
  }

  async rename(file: TFile, newPath: string): Promise<void> {
    const normalized = normalizePath(newPath);
    const absolute = await this.resolveAbsolute(normalized);
    const parentPath = normalized.includes("/")
      ? normalized.split("/").slice(0, -1).join("/")
      : "";
    if (parentPath) {
      await mkdir(await this.resolveAbsolute(parentPath), { recursive: true });
      await this.ensureFolderIndexed(parentPath);
    }

    await rename(file.absolutePath, absolute);
    await this.applyExternalChange({
      kind: "rename",
      oldPath: file.absolutePath,
      path: absolute
    });
  }

  getResourcePath(file: TFile): string {
    return file.absolutePath;
  }

  async applyExternalChange(event: {
    kind: "create" | "modify" | "remove" | "rename";
    path: string;
    oldPath?: string | null;
    mtimeMs?: number | null;
    size?: number | null;
    contentHash?: string | null;
    content?: string | null;
  }): Promise<boolean> {
    const relativePath = this.relativeFromAbsolute(event.path);
    if (!relativePath) return false;
    this.advanceIndexGeneration();
    const resolveEventStat = async (): Promise<{ mtime: number; size: number }> => {
      if (event.mtimeMs != null && event.size != null) {
        return { mtime: event.mtimeMs, size: event.size };
      }
      const info = await stat(event.path);
      return {
        mtime: typeof info.mtime === "number" ? info.mtime : Number(info.mtime ?? 0),
        size: info.size ?? 0
      };
    };

    if (event.kind === "rename") {
      const oldRelative = event.oldPath ? this.relativeFromAbsolute(event.oldPath) : null;
      if (!oldRelative) return false;

      const existing = this.filesByPath.get(oldRelative);
      if (existing) {
        this.filesByPath.delete(oldRelative);
        this.metadataCache.clearFile(oldRelative);
        this.unlinkFromParent(oldRelative);
      }

      try {
        const parentPath = this.parentFolderPath(relativePath);
        if (parentPath) {
          await this.ensureFolderIndexed(parentPath);
        }
        const { mtime, size } = await resolveEventStat();
        const name = relativePath.split("/").pop() ?? relativePath;
        const renamed = existing ?? new TFile(relativePath, name, event.path, { mtime, size });
        renamed.path = relativePath;
        renamed.name = name;
        renamed.absolutePath = event.path;
        renamed.stat = { mtime, size };
        const parts = name.split(".");
        renamed.extension = parts.length > 1 ? parts[parts.length - 1] : "";
        renamed.basename = parts.length > 1 ? parts.slice(0, -1).join(".") : name;
        this.filesByPath.set(relativePath, renamed);
        this.linkFileToParent(renamed);
        this.files = Array.from(this.filesByPath.values());
        if (renamed.extension === "md") {
          const content = event.content ?? await readTextFile(event.path);
          this.metadataCache.updateFile(renamed, content);
        }
        this.trigger("rename", renamed, oldRelative);
        return true;
      } catch {
        return false;
      }
    }

    if (event.kind === "remove") {
      const existing = this.filesByPath.get(relativePath);
      if (!existing) return false;
      this.filesByPath.delete(relativePath);
      this.unlinkFromParent(relativePath);
      this.files = Array.from(this.filesByPath.values());
      this.metadataCache.clearFile(relativePath);
      this.trigger("delete", existing);
      return true;
    }

    try {
      const parentPath = this.parentFolderPath(relativePath);
      if (parentPath) {
        await this.ensureFolderIndexed(parentPath);
      }
      const { mtime, size } = await resolveEventStat();
      const existing = this.filesByPath.get(relativePath);
      const name = relativePath.split("/").pop() ?? relativePath;
      const file = existing ?? new TFile(relativePath, name, event.path, { mtime, size });
      file.path = relativePath;
      file.name = name;
      file.absolutePath = event.path;
      file.stat = { mtime, size };
      const parts = name.split(".");
      file.extension = parts.length > 1 ? parts[parts.length - 1] : "";
      file.basename = parts.length > 1 ? parts.slice(0, -1).join(".") : name;
      this.filesByPath.set(relativePath, file);
      this.linkFileToParent(file);
      this.files = Array.from(this.filesByPath.values());

      if (file.extension === "md") {
        const content = event.content ?? await readTextFile(event.path);
        this.metadataCache.updateFile(file, content);
      } else {
        this.metadataCache.clearFile(relativePath);
      }

      this.trigger(existing ? "modify" : "create", file);
      return true;
    } catch {
      return false;
    }
  }
}

export class WorkspaceLeaf {
  view: { getViewType?: () => string } | null = null;

  constructor(private workspace: Workspace) {}

  getViewState() {
    return { pinned: false };
  }

  async openFile(file: TFile, _options?: { active?: boolean }) {
    this.workspace.setActiveFile(file);
  }

  async setViewState(_state: { type: string; active?: boolean }) {
    return;
  }
}

export class Workspace {
  private leaf = new WorkspaceLeaf(this);
  private activeFile: TFile | null = null;
  private onActiveFileChange?: (file: TFile | null) => void;

  constructor(onActiveFileChange?: (file: TFile | null) => void) {
    this.onActiveFileChange = onActiveFileChange;
  }

  getLeaf(_create: boolean | "split" = false, _direction?: "vertical" | "horizontal") {
    return this.leaf;
  }

  getLeavesOfType(_type: string) {
    return [this.leaf];
  }

  getMostRecentLeaf() {
    return this.leaf;
  }

  revealLeaf(_leaf: WorkspaceLeaf) {
    return;
  }

  onLayoutReady(callback: () => void) {
    setTimeout(callback, 0);
  }

  detachLeavesOfType(_type: string) {
    return;
  }

  getActiveFile() {
    return this.activeFile;
  }

  setActiveFile(file: TFile | null) {
    this.activeFile = file;
    this.onActiveFileChange?.(file);
  }
}

export class App {
  vault: Vault;
  metadataCache: MetadataCache;
  fileManager: FileManager;
  workspace: Workspace;
  cookingCapabilities: CookingCapabilities;

  constructor(
    vault: Vault,
    metadataCache: MetadataCache,
    workspace: Workspace,
    cookingCapabilities: CookingCapabilities = createCookingCapabilities()
  ) {
    this.vault = vault;
    this.metadataCache = metadataCache;
    this.workspace = workspace;
    this.fileManager = new FileManager(this);
    this.cookingCapabilities = cookingCapabilities;
  }
}

export class Notice {
  constructor(message: string, timeout = 4000) {
    window.dispatchEvent(
      new CustomEvent("mep-notice", {
        detail: { message, timeout }
      })
    );
  }
}

export class Modal {
  contentEl: HTMLDivElement;
  titleEl: HTMLHeadingElement;
  modalEl: HTMLDivElement;
  private overlayEl: HTMLDivElement | null = null;
  private overlayClick?: (event: MouseEvent) => void;

  constructor(_app: App) {
    ensureElementHelpers();
    this.modalEl = document.createElement("div");
    this.modalEl.className = "mep-modal";
    this.titleEl = document.createElement("h3");
    this.contentEl = document.createElement("div");
    this.modalEl.append(this.titleEl, this.contentEl);
  }

  open() {
    const overlay = document.createElement("div");
    overlay.className = "mep-modal-overlay";
    this.overlayClick = () => this.close();
    overlay.addEventListener("click", this.overlayClick);
    overlay.appendChild(this.modalEl);
    document.body.appendChild(overlay);
    this.modalEl.dataset.open = "true";
    this.overlayEl = overlay;
  }

  close() {
    if (this.overlayEl && this.overlayClick) {
      this.overlayEl.removeEventListener("click", this.overlayClick);
    }
    this.overlayEl?.remove();
    this.overlayEl = null;
    this.overlayClick = undefined;
  }
}

export const Platform = {
  isMobile: false,
  isDesktopApp: true,
  isDesktop: true,
  isIos: false,
  isAndroid: false
};

const ICON_SVGS: Record<string, string> = {
  "calendar-days": "<svg viewBox=\"0 0 24 24\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\" ry=\"2\"></rect><line x1=\"16\" y1=\"2\" x2=\"16\" y2=\"6\"></line><line x1=\"8\" y1=\"2\" x2=\"8\" y2=\"6\"></line><line x1=\"3\" y1=\"10\" x2=\"21\" y2=\"10\"></line></svg>",
  "layout-grid": "<svg viewBox=\"0 0 24 24\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"3\" width=\"7\" height=\"7\"></rect><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\"></rect><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\"></rect><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\"></rect></svg>",
  activity: "<svg viewBox=\"0 0 24 24\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"22 12 18 12 15 21 9 3 6 12 2 12\"></polyline></svg>",
  settings: "<svg viewBox=\"0 0 24 24\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"3\"></circle><path d=\"M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z\"></path></svg>",
  "arrow-left": "<svg viewBox=\"0 0 24 24\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><line x1=\"19\" y1=\"12\" x2=\"5\" y2=\"12\"></line><polyline points=\"12 19 5 12 12 5\"></polyline></svg>",
  "chevrons-left": "<svg viewBox=\"0 0 24 24\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"11 17 6 12 11 7\"></polyline><polyline points=\"18 17 13 12 18 7\"></polyline></svg>",
  "chevrons-right": "<svg viewBox=\"0 0 24 24\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"13 17 18 12 13 7\"></polyline><polyline points=\"6 17 11 12 6 7\"></polyline></svg>"
};

export function setIcon(el: HTMLElement, icon: string): void {
  el.innerHTML = ICON_SVGS[icon] ?? "";
}

export { moment };

export async function createStandaloneApp(
  vaultPath: string,
  onActiveFileChange?: (file: TFile | null) => void,
  options?: { deferInitialRefresh?: boolean }
): Promise<App> {
  if (!vaultPath) {
    const base = await appDataDir();
    vaultPath = await join(base, "vault");
  }
  const vault = new Vault(vaultPath);
  const metadataCache = vault.metadataCache;
  const workspace = new Workspace(onActiveFileChange);
  const app = new App(vault, metadataCache, workspace);
  if (!options?.deferInitialRefresh) {
    await vault.refresh();
  }
  return app;
}
