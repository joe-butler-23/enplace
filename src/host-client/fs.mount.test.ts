import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FileTree =
  | string
  | Uint8Array
  | {
      [name: string]: FileTree;
    };

type FakeFileNode = {
  kind: "file";
  name: string;
  data: Uint8Array;
  lastModified: number;
};

type FakeDirectoryNode = {
  kind: "directory";
  name: string;
  children: Map<string, FakeNode>;
};

type FakeNode = FakeFileNode | FakeDirectoryNode;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class LocalStorageMock {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

function createDirectoryNode(name: string): FakeDirectoryNode {
  return {
    kind: "directory",
    name,
    children: new Map<string, FakeNode>()
  };
}

function createTree(name: string, tree: FileTree): FakeDirectoryNode {
  const root = createDirectoryNode(name);
  if (typeof tree !== "object" || tree instanceof Uint8Array) {
    throw new Error("Root tree must be a directory.");
  }

  for (const [entryName, value] of Object.entries(tree)) {
    root.children.set(entryName, createNode(entryName, value));
  }
  return root;
}

function createNode(name: string, value: FileTree): FakeNode {
  if (typeof value === "string") {
    return {
      kind: "file",
      name,
      data: encoder.encode(value),
      lastModified: Date.now()
    };
  }
  if (value instanceof Uint8Array) {
    return {
      kind: "file",
      name,
      data: new Uint8Array(value),
      lastModified: Date.now()
    };
  }

  const directory = createDirectoryNode(name);
  for (const [entryName, child] of Object.entries(value)) {
    directory.children.set(entryName, createNode(entryName, child));
  }
  return directory;
}

function notFoundError(message: string): Error {
  try {
    return new DOMException(message, "NotFoundError");
  } catch {
    const error = new Error(message);
    error.name = "NotFoundError";
    return error;
  }
}

function toBytes(data: string | ArrayBuffer | Uint8Array | ArrayBufferView | Blob): Promise<Uint8Array> | Uint8Array {
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

class FakeFileHandle {
  readonly kind = "file" as const;

  constructor(private readonly node: FakeFileNode) {}

  get name(): string {
    return this.node.name;
  }

  async getFile() {
    const data = new Uint8Array(this.node.data);
    return {
      size: data.length,
      lastModified: this.node.lastModified,
      text: async () => decoder.decode(data),
      arrayBuffer: async () =>
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    };
  }

  async createWritable() {
    let next = new Uint8Array(this.node.data);
    return {
      write: async (data: string | ArrayBuffer | Uint8Array | ArrayBufferView | Blob) => {
        next = await Promise.resolve(toBytes(data));
      },
      close: async () => {
        this.node.data = new Uint8Array(next);
        this.node.lastModified = Date.now();
      }
    };
  }

  async queryPermission() {
    return "granted" as const;
  }

  async requestPermission() {
    return "granted" as const;
  }
}

class FakeDirectoryHandle {
  readonly kind = "directory" as const;

  constructor(private readonly node: FakeDirectoryNode) {}

  get name(): string {
    return this.node.name;
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<FakeDirectoryHandle> {
    const existing = this.node.children.get(name);
    if (existing?.kind === "directory") {
      return new FakeDirectoryHandle(existing);
    }
    if (existing) {
      throw new DOMException(`${name} already exists as a file.`, "TypeMismatchError");
    }
    if (!options?.create) {
      throw notFoundError(`Directory not found: ${name}`);
    }
    const directory = createDirectoryNode(name);
    this.node.children.set(name, directory);
    return new FakeDirectoryHandle(directory);
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    const existing = this.node.children.get(name);
    if (existing?.kind === "file") {
      return new FakeFileHandle(existing);
    }
    if (existing) {
      throw new DOMException(`${name} already exists as a directory.`, "TypeMismatchError");
    }
    if (!options?.create) {
      throw notFoundError(`File not found: ${name}`);
    }
    const file: FakeFileNode = {
      kind: "file",
      name,
      data: new Uint8Array(),
      lastModified: Date.now()
    };
    this.node.children.set(name, file);
    return new FakeFileHandle(file);
  }

  async removeEntry(name: string, options?: { recursive?: boolean }) {
    const existing = this.node.children.get(name);
    if (!existing) {
      throw notFoundError(`Entry not found: ${name}`);
    }
    if (existing.kind === "directory" && existing.children.size > 0 && !options?.recursive) {
      throw new Error(`Directory not empty: ${name}`);
    }
    this.node.children.delete(name);
  }

  async *entries(): AsyncGenerator<[string, FakeDirectoryHandle | FakeFileHandle], void, void> {
    for (const [name, child] of this.node.children.entries()) {
      if (child.kind === "directory") {
        yield [name, new FakeDirectoryHandle(child)];
      } else {
        yield [name, new FakeFileHandle(child)];
      }
    }
  }

  async queryPermission() {
    return "granted" as const;
  }

  async requestPermission() {
    return "granted" as const;
  }
}

describe("web fs shim", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(globalThis, "localStorage", {
      value: new LocalStorageMock(),
      configurable: true
    });
    delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    delete (globalThis as { prompt?: unknown }).prompt;
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    delete (globalThis as { prompt?: unknown }).prompt;
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("mounts a picked directory at /home/vault and shadows fixture files", async () => {
    const mountedVault = new FakeDirectoryHandle(
      createTree("picked-vault", {
        recipes: {
          "live-recipe.md": "---\ntitle: Live Recipe\n---\n"
        }
      })
    );
    (globalThis as { showDirectoryPicker?: () => Promise<unknown> }).showDirectoryPicker =
      vi.fn().mockResolvedValue(mountedVault);

    const dialog = await import("./dialog");
    const fs = await import("./fs");

    const selected = await dialog.open({ directory: true, multiple: false });
    const liveRecipe = await fs.readTextFile("/home/vault/recipes/live-recipe.md");
    const fixtureRecipeExists = await fs.exists(
      "/home/vault/recipes/fixture-coq-au-riesling.md"
    );

    await fs.writeTextFile("/home/vault/inbox/new-job.json", '{"type":"url"}');
    const newJob = await fs.readTextFile("/home/vault/inbox/new-job.json");

    expect(selected).toBe("/home/vault");
    expect(liveRecipe).toContain("Live Recipe");
    expect(fixtureRecipeExists).toBe(false);
    expect(newJob).toContain('"type":"url"');
  });

  it("lists subdirectories in a mounted vault", async () => {
    const mountedVault = new FakeDirectoryHandle(
      createTree("picked-vault", {
        recipes: {
          "live-recipe.md": "recipe"
        }
      })
    );
    (globalThis as { showDirectoryPicker?: () => Promise<unknown> }).showDirectoryPicker =
      vi.fn().mockResolvedValue(mountedVault);

    const dialog = await import("./dialog");
    const fs = await import("./fs");

    await dialog.open({ directory: true, multiple: false });
    const entries = await fs.readDir("/home/vault");
    const recipeEntries = await fs.readDir("/home/vault/recipes");

    expect(entries).toContainEqual({
      name: "recipes",
      isFile: false,
      isDirectory: true,
      isSymlink: false,
    });
    expect(recipeEntries).toContainEqual({
      name: "live-recipe.md",
      isFile: true,
      isDirectory: false,
      isSymlink: false
    });
  });

  it("persists virtual app-data files across module reloads", async () => {
    const firstFs = await import("./fs");
    await firstFs.writeTextFile("/appdata/settings.json", '{"vaultPath":"/home/vault"}');

    vi.resetModules();

    const reloadedFs = await import("./fs");
    const settings = await reloadedFs.readTextFile("/appdata/settings.json");
    const fixtureExists = await reloadedFs.exists(
      "/home/vault/recipes/fixture-coq-au-riesling.md"
    );

    expect(settings).toContain('"vaultPath":"/home/vault"');
    expect(fixtureExists).toBe(true);
  });
});
