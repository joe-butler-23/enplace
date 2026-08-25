import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  readTextFile: vi.fn(),
  readTextFiles: vi.fn(),
  writeTextFile: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  readDir: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  exists: vi.fn(),
  stat: vi.fn()
}));

const pathMock = vi.hoisted(() => ({
  appDataDir: vi.fn(),
  join: vi.fn()
}));

const coreMock = vi.hoisted(() => ({
  invoke: vi.fn()
}));

vi.mock("@/host-client/fs", () => fsMock);
vi.mock("@/host-client/path", () => pathMock);
vi.mock("@/host-client/invoke", () => coreMock);

function joinPath(...parts: string[]): string {
  const cleaned = parts
    .filter((part) => part && part.length > 0)
    .map((part) => part.replace(/^\/+|\/+$/g, ""));
  if (cleaned.length === 0) return "/";
  return `/${cleaned.join("/")}`.replace(/\/+/g, "/");
}

describe("Vault filesystem behavior", () => {
  afterEach(() => {
    delete (globalThis as { __MEP_REMOTE_HOST__?: unknown }).__MEP_REMOTE_HOST__;
  });

  beforeEach(() => {
    vi.resetModules();
    fsMock.readTextFile.mockReset();
    fsMock.readTextFiles.mockReset();
    fsMock.writeTextFile.mockReset();
    fsMock.readFile.mockReset();
    fsMock.writeFile.mockReset();
    fsMock.mkdir.mockReset();
    fsMock.readDir.mockReset();
    fsMock.remove.mockReset();
    fsMock.rename.mockReset();
    fsMock.exists.mockReset();
    fsMock.stat.mockReset();
    pathMock.appDataDir.mockReset();
    pathMock.join.mockReset();
    coreMock.invoke.mockReset();

    pathMock.appDataDir.mockResolvedValue("/appdata/com.mise.en.place");
    pathMock.join.mockImplementation(async (...parts: string[]) => joinPath(...parts));
    fsMock.mkdir.mockResolvedValue(undefined);
    fsMock.remove.mockResolvedValue(undefined);
    fsMock.exists.mockResolvedValue(false);
    fsMock.readTextFiles.mockImplementation((paths: string[]) =>
      Promise.all(paths.map((path) => fsMock.readTextFile(path)))
    );
    coreMock.invoke.mockResolvedValue(undefined);
  });

  it("renames binary files without text transcoding", async () => {
    const { TFile, Vault } = await import("./platform");
    const vault = new Vault("/vault");

    const imageBytes = Uint8Array.from([0, 255, 1, 2, 3]);
    fsMock.readFile.mockResolvedValue(imageBytes);
    fsMock.readDir.mockResolvedValue([]);

    const file = new TFile(
      "inbox/photo.png",
      "photo.png",
      "/vault/inbox/photo.png",
      { mtime: 123, size: imageBytes.length }
    );

    await vault.rename(file, "inbox/archive/photo.png");

    expect(fsMock.rename).toHaveBeenCalledWith(
      "/vault/inbox/photo.png",
      "/vault/inbox/archive/photo.png"
    );
    expect(fsMock.mkdir).toHaveBeenCalledWith("/vault/inbox/archive", {
      recursive: true
    });
    expect(fsMock.readTextFile).not.toHaveBeenCalled();
    expect(fsMock.writeTextFile).not.toHaveBeenCalled();
    expect(fsMock.readFile).not.toHaveBeenCalled();
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(fsMock.remove).not.toHaveBeenCalled();
  });

  it("resolves links against the owning vault when multiple runtimes exist", async () => {
    const { TFile, Vault } = await import("./platform");
    fsMock.stat.mockResolvedValue({ mtime: 123, size: 8 });
    fsMock.readTextFile.mockResolvedValue("---\ntitle: Note\n---\n");

    const firstVault = new Vault("/first");
    const secondVault = new Vault("/second");
    const firstFile = await firstVault.createOrOverwrite("notes/first.md", "first");
    const secondFile = await secondVault.createOrOverwrite("notes/second.md", "second");

    expect(firstVault.metadataCache.getFirstLinkpathDest("notes/first.md", "index.md")).toBe(firstFile);
    expect(secondVault.metadataCache.getFirstLinkpathDest("notes/second.md", "index.md")).toBe(secondFile);
    expect(firstVault.metadataCache.getFirstLinkpathDest("notes/second.md", "index.md")).toBeNull();
    expect(firstFile).toBeInstanceOf(TFile);
  });

  it("indexes recipes/.machine sidecar files during refresh", async () => {
    const { TFile, Vault } = await import("./platform");
    const vault = new Vault("/vault");
    const metadataCache = vault.metadataCache;

    fsMock.readDir.mockImplementation(async (path: string) => {
      switch (path) {
        case "/vault":
          return [{ name: "recipes", isDirectory: true }];
        case "/vault/recipes":
          return [
            { name: ".machine", isDirectory: true },
            { name: "fixture.md", isDirectory: false }
          ];
        case "/vault/recipes/.machine":
          return [{ name: "fixture.json", isDirectory: false }];
        default:
          return [];
      }
    });

    fsMock.stat.mockImplementation(async (path: string) => {
      if (path === "/vault/recipes/fixture.md") {
        return { mtime: 111, size: 42 };
      }
      if (path === "/vault/recipes/.machine/fixture.json") {
        return { mtime: 222, size: 15 };
      }
      return { mtime: 0, size: 0 };
    });

    fsMock.readTextFile.mockImplementation(async (path: string) => {
      if (path === "/vault/recipes/fixture.md") {
        return "---\ntitle: Fixture\n---\n\n# Fixture\n";
      }
      return "";
    });

    await vault.refresh();

    const markdown = vault.getAbstractFileByPath("recipes/fixture.md");
    const sidecar = vault.getAbstractFileByPath("recipes/.machine/fixture.json");

    expect(markdown).toBeInstanceOf(TFile);
    expect(sidecar).toBeInstanceOf(TFile);
  });

  it("uses authoritative directory metadata without per-file stat requests", async () => {
    const { TFile, Vault } = await import("./platform");
    const vault = new Vault("/vault");
    const metadataCache = vault.metadataCache;

    fsMock.readDir.mockImplementation(async (path: string) => {
      if (path === "/vault") {
        return [{
          name: "recipe.md",
          isDirectory: false,
          mtime: new Date(123),
          size: 42
        }];
      }
      return [];
    });
    fsMock.readTextFile.mockResolvedValue("---\ntitle: Recipe\n---\n");

    await vault.refresh();

    const file = vault.getAbstractFileByPath("recipe.md");
    expect(file).toBeInstanceOf(TFile);
    expect((file as TFile).stat).toEqual({ mtime: 123, size: 42 });
    expect(fsMock.stat).not.toHaveBeenCalled();
  });

  it("uses one recursive inventory and one ordered text batch for a remote vault refresh", async () => {
    (globalThis as { __MEP_REMOTE_HOST__?: unknown }).__MEP_REMOTE_HOST__ = {
      mode: "remote-host"
    };
    const { Vault } = await import("./platform");
    const vault = new Vault("/vault");
    let includeOmelette = true;
    let pastaMtime = 222;
    let pastaTitle = "Pasta";
    const inventory = () => [{
      name: "recipes",
      isDirectory: true,
      children: [
        ...(includeOmelette ? [{
          name: "breakfast",
          isDirectory: true,
          children: [{
            name: "omelette.md",
            isDirectory: false,
            mtime: new Date(111),
            size: 21
          }]
        }] : []),
        {
          name: "pasta.md",
          isDirectory: false,
          mtime: new Date(pastaMtime),
          size: 18
        }
      ]
    }];

    fsMock.readDir.mockImplementation(async (path: string) => {
      if (path === "/vault") return inventory();
      if (path === "/vault/recipes") return inventory()[0].children;
      if (path === "/vault/recipes/breakfast" && includeOmelette) {
        return inventory()[0].children[0].children;
      }
      return [];
    });
    fsMock.readTextFiles.mockImplementation(async (paths: string[]) => paths.map((path) => {
      if (path === "/vault/recipes/breakfast/omelette.md") {
        return "---\ntitle: Omelette\n---\n";
      }
      if (path === "/vault/recipes/pasta.md") {
        return `---\ntitle: ${pastaTitle}\n---\n`;
      }
      throw new Error(`Unexpected text path: ${path}`);
    }));
    fsMock.readTextFile.mockImplementation(async (path: string) => {
      if (path === "/vault/recipes/breakfast/omelette.md") {
        return "---\ntitle: Omelette\n---\n";
      }
      if (path === "/vault/recipes/pasta.md") {
        return `---\ntitle: ${pastaTitle}\n---\n`;
      }
      throw new Error(`Unexpected text path: ${path}`);
    });

    await expect(vault.refresh()).resolves.toBe(true);

    expect(vault.getMarkdownFiles().map((file) => file.path)).toEqual([
      "recipes/breakfast/omelette.md",
      "recipes/pasta.md"
    ]);
    expect(vault.metadataCache.getFileCache(vault.getMarkdownFiles()[0])?.frontmatter?.title)
      .toBe("Omelette");
    expect(vault.metadataCache.getFileCache(vault.getMarkdownFiles()[1])?.frontmatter?.title)
      .toBe("Pasta");
    expect(fsMock.readDir).toHaveBeenCalledTimes(1);
    expect(fsMock.readDir).toHaveBeenCalledWith("/vault", { recursive: true });
    expect(fsMock.readTextFiles).toHaveBeenCalledWith([
      "/vault/recipes/breakfast/omelette.md",
      "/vault/recipes/pasta.md"
    ]);
    expect(fsMock.readTextFile).not.toHaveBeenCalled();
    expect(fsMock.stat).not.toHaveBeenCalled();

    includeOmelette = false;
    pastaMtime = 333;
    pastaTitle = "Updated Pasta";
    await expect(vault.refresh()).resolves.toBe(true);
    expect(vault.getAbstractFileByPath("recipes/breakfast/omelette.md")).toBeNull();
    expect(vault.metadataCache.getFileCache(vault.getMarkdownFiles()[0])?.frontmatter?.title)
      .toBe("Updated Pasta");
    expect(fsMock.readDir).toHaveBeenCalledTimes(2);
    expect(fsMock.readTextFiles).toHaveBeenCalledTimes(2);
    expect(fsMock.readTextFiles).toHaveBeenLastCalledWith(["/vault/recipes/pasta.md"]);
  });

  it("chunks more than 4,096 changed markdown files into ordered text batches", async () => {
    const { Vault } = await import("./platform");
    const vault = new Vault("/vault");
    const entries = Array.from({ length: 4_097 }, (_, index) => ({
      name: `recipe-${String(index).padStart(4, "0")}.md`,
      isDirectory: false,
      mtime: new Date(index + 1),
      size: index + 1
    }));
    fsMock.readDir.mockResolvedValue(entries);
    fsMock.readTextFiles.mockImplementation(async (paths: string[]) => {
      if (paths.length > 4_096) {
        throw new Error("Remote text batch exceeds 4,096 paths.");
      }
      return paths.map((path) => `#${path.split("/").pop()?.replace(/\.md$/, "")}\n`);
    });

    await expect(vault.refresh()).resolves.toBe(true);

    expect(fsMock.readTextFiles).toHaveBeenCalledTimes(2);
    const firstBatch = fsMock.readTextFiles.mock.calls[0][0] as string[];
    const secondBatch = fsMock.readTextFiles.mock.calls[1][0] as string[];
    expect(firstBatch).toHaveLength(4_096);
    expect(firstBatch[0]).toBe("/vault/recipe-0000.md");
    expect(firstBatch[4_095]).toBe("/vault/recipe-4095.md");
    expect(secondBatch).toEqual(["/vault/recipe-4096.md"]);
    expect(vault.metadataCache.getFileCache(vault.getMarkdownFiles()[0])?.tags)
      .toEqual(["#recipe-0000"]);
    expect(vault.metadataCache.getFileCache(vault.getMarkdownFiles()[4_096])?.tags)
      .toEqual(["#recipe-4096"]);
  });

  it("does not request a text batch when no markdown files changed", async () => {
    const { Vault } = await import("./platform");
    const vault = new Vault("/vault");
    fsMock.readDir.mockResolvedValue([]);

    await expect(vault.refresh()).resolves.toBe(false);

    expect(fsMock.readTextFiles).not.toHaveBeenCalled();
    expect(fsMock.readTextFile).not.toHaveBeenCalled();
  });

  it("does not resolve a folder refresh before required markdown hydration", async () => {
    const { TFile, Vault } = await import("./platform");
    const vault = new Vault("/vault");
    const metadataCache = vault.metadataCache;
    let releaseRead: ((content: string) => void) | undefined;

    fsMock.readDir.mockImplementation(async (path: string) => {
      if (path === "/vault/recipes") {
        return [{
          name: "recipe.md",
          isDirectory: false,
          mtime: new Date(123),
          size: 42
        }];
      }
      return [];
    });
    fsMock.readTextFile.mockImplementation(() => new Promise<string>((resolve) => {
      releaseRead = resolve;
    }));

    let refreshResolved = false;
    const refresh = vault.refreshFolder("recipes").then(() => {
      refreshResolved = true;
    });
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf("function"));
    expect(refreshResolved).toBe(false);

    releaseRead?.("---\ntitle: Current Recipe\n---\n");
    await refresh;

    const file = vault.getAbstractFileByPath("recipes/recipe.md");
    expect(file).toBeInstanceOf(TFile);
    expect(metadataCache.getFileCache(file as InstanceType<typeof TFile>)?.frontmatter?.title)
      .toBe("Current Recipe");
  });

  it("skips reading unchanged markdown files after the initial refresh", async () => {
    const { Vault } = await import("./platform");
    const vault = new Vault("/vault");
    const metadataCache = vault.metadataCache;

    fsMock.readDir.mockImplementation(async (path: string) => {
      if (path === "/vault") return [{ name: "recipe.md", isDirectory: false }];
      return [];
    });
    fsMock.stat.mockResolvedValue({ mtime: 123, size: 42 });
    fsMock.readTextFile.mockResolvedValue("---\ntitle: Recipe\n---\n");

    await vault.refresh();
    expect(fsMock.readTextFile).toHaveBeenCalledTimes(1);

    await vault.refresh();

    expect(fsMock.readTextFile).toHaveBeenCalledTimes(1);
  });

  it("force refresh rereads markdown with an unchanged metadata signature", async () => {
    const { Vault } = await import("./platform");
    const vault = new Vault("/vault");

    fsMock.readDir.mockImplementation(async (path: string) => {
      if (path === "/vault") return [{ name: "recipe.md", isDirectory: false }];
      return [];
    });
    fsMock.stat.mockResolvedValue({ mtime: 123, size: 42 });
    fsMock.readTextFile
      .mockResolvedValueOnce("---\ntitle: Before\n---\n")
      .mockResolvedValueOnce("---\ntitle: After\n---\n");

    await vault.refresh();
    const changed = await vault.refresh(true);

    expect(changed).toBe(true);
    expect(fsMock.readTextFile).toHaveBeenCalledTimes(2);
  });

  it("rejects external paths outside vault root boundary", async () => {
    const { Vault } = await import("./platform");
    const vault = new Vault("/vault");
    const metadataCache = vault.metadataCache;

    const changed = await vault.applyExternalChange({
      kind: "create",
      path: "/vault-backup/inbox/item.md"
    });

    expect(changed).toBe(false);
    expect(fsMock.stat).not.toHaveBeenCalled();
  });

  it("applies self-sufficient watcher metadata without filesystem IPC", async () => {
    const { TFile, Vault } = await import("./platform");
    const vault = new Vault("/vault");
    const metadataCache = vault.metadataCache;

    const changed = await vault.applyExternalChange({
      kind: "modify",
      path: "/vault/recipe.md",
      mtimeMs: 456,
      size: 7,
      contentHash: "deadbeefdeadbeef",
      content: "recipe"
    });

    expect(changed).toBe(true);
    expect(fsMock.stat).not.toHaveBeenCalled();
    expect(fsMock.readTextFile).not.toHaveBeenCalled();
    const file = vault.getAbstractFileByPath("recipe.md");
    expect(file).toBeInstanceOf(TFile);
    expect((file as TFile).stat).toEqual({ mtime: 456, size: 7 });
  });

  it("reads only content when a watcher entry exceeds the inline cap", async () => {
    const { Vault } = await import("./platform");
    const vault = new Vault("/vault");
    fsMock.readTextFile.mockResolvedValue("large recipe");

    const changed = await vault.applyExternalChange({
      kind: "modify",
      path: "/vault/large.md",
      mtimeMs: 789,
      size: 40_000,
      contentHash: "feedfacefeedface"
    });

    expect(changed).toBe(true);
    expect(fsMock.stat).not.toHaveBeenCalled();
    expect(fsMock.readTextFile).toHaveBeenCalledOnce();
    expect(fsMock.readTextFile).toHaveBeenCalledWith("/vault/large.md");
  });

  it("updates folder children when external files are created", async () => {
    const { TFile, TFolder, Vault } = await import("./platform");
    const vault = new Vault("/vault");
    const metadataCache = vault.metadataCache;

    fsMock.readDir.mockImplementation(async (path: string) => {
      switch (path) {
        case "/vault":
          return [{ name: "inbox", isDirectory: true }];
        case "/vault/inbox":
          return [];
        default:
          return [];
      }
    });
    fsMock.stat.mockResolvedValue({ mtime: 123, size: 12 });
    fsMock.readTextFile.mockResolvedValue("---\ntitle: Item\n---\n");

    await vault.refresh();
    const changed = await vault.applyExternalChange({
      kind: "create",
      path: "/vault/inbox/item.md"
    });

    expect(changed).toBe(true);
    const folder = vault.getAbstractFileByPath("inbox");
    expect(folder).toBeInstanceOf(TFolder);
    expect((folder as TFolder).children[0]).toBeInstanceOf(TFile);
    expect((folder as TFolder).children[0].path).toBe("inbox/item.md");
  });

  it("rejects create for existing files and allows explicit overwrite", async () => {
    const { Vault } = await import("./platform");
    const vault = new Vault("/vault");
    const metadataCache = vault.metadataCache;

    fsMock.readDir.mockResolvedValue([{ name: "existing.md", isDirectory: false }]);
    fsMock.stat.mockResolvedValue({ mtime: 123, size: 8 });
    fsMock.readTextFile.mockResolvedValue("original");
    await vault.refresh();

    await expect(vault.create("existing.md", "replacement")).rejects.toThrow("File already exists.");
    expect(fsMock.writeTextFile).not.toHaveBeenCalled();
    expect(fsMock.readTextFile).toHaveBeenCalledWith("/vault/existing.md");

    await vault.createOrOverwrite("existing.md", "replacement");
    expect(fsMock.writeTextFile).toHaveBeenCalledWith("/vault/existing.md", "replacement");
  });

  it("rejects an old folder inventory when an external modify lands during readDir", async () => {
    const { TFile, Vault } = await import("./platform");
    const vault = new Vault("/vault");
    const oldEntry = { name: "recipe.md", isDirectory: false, mtime: new Date(1), size: 10 };
    fsMock.readDir.mockResolvedValue([oldEntry]);
    fsMock.readTextFiles.mockResolvedValue(["---\ntitle: Old\n---\n"]);
    await vault.refreshFolder("recipes");

    let releaseInventory: ((entries: typeof oldEntry[]) => void) | undefined;
    fsMock.readDir.mockImplementation(() => new Promise((resolve) => {
      releaseInventory = resolve;
    }));
    const staleIndex = vault.indexFolder("recipes");
    await vi.waitFor(() => expect(releaseInventory).toBeTypeOf("function"));
    await vault.applyExternalChange({
      kind: "modify",
      path: "/vault/recipes/recipe.md",
      mtimeMs: 2,
      size: 20,
      content: "---\ntitle: New\n---\n"
    });
    releaseInventory?.([oldEntry]);

    await expect(staleIndex).rejects.toThrow("superseded");
    const file = vault.getAbstractFileByPath("recipes/recipe.md");
    expect(file).toBeInstanceOf(TFile);
    expect((file as InstanceType<typeof TFile>).stat).toEqual({ mtime: 2, size: 20 });
    expect(vault.metadataCache.getFileCache(file as InstanceType<typeof TFile>)?.frontmatter?.title)
      .toBe("New");
  });

  it("rejects an old full inventory instead of resurrecting a file removed during readDir", async () => {
    const { Vault } = await import("./platform");
    const vault = new Vault("/vault");
    const oldEntry = { name: "recipe.md", isDirectory: false, mtime: new Date(1), size: 10 };
    fsMock.readDir.mockResolvedValue([oldEntry]);
    fsMock.readTextFiles.mockResolvedValue(["---\ntitle: Old\n---\n"]);
    await vault.refresh();

    let releaseInventory: ((entries: typeof oldEntry[]) => void) | undefined;
    fsMock.readDir.mockImplementation(() => new Promise((resolve) => {
      releaseInventory = resolve;
    }));
    const staleRefresh = vault.refresh();
    await vi.waitFor(() => expect(releaseInventory).toBeTypeOf("function"));
    await vault.applyExternalChange({ kind: "remove", path: "/vault/recipe.md" });
    releaseInventory?.([oldEntry]);

    await expect(staleRefresh).rejects.toThrow("superseded");
    expect(vault.getAbstractFileByPath("recipe.md")).toBeNull();
    expect(vault.metadataCache.snapshot()).not.toHaveProperty("recipe.md");
  });

  it("indexes a folder without reading Markdown and exposes hydration completion", async () => {
    const { TFile, Vault } = await import("./platform");
    const vault = new Vault("/vault");
    let releaseRead: ((contents: string[]) => void) | undefined;
    fsMock.readDir.mockResolvedValue([{
      name: "recipe.md",
      isDirectory: false,
      mtime: new Date(1),
      size: 10
    }]);
    fsMock.readTextFiles.mockImplementation(() => new Promise<string[]>((resolve) => {
      releaseRead = resolve;
    }));

    const indexed = await vault.indexFolder("recipes");
    const file = vault.getAbstractFileByPath("recipes/recipe.md");
    expect(file).toBeInstanceOf(TFile);
    expect(fsMock.readTextFiles).not.toHaveBeenCalled();
    expect(vault.metadataCache.getFileCache(file as InstanceType<typeof TFile>)).toBeNull();

    let settled = false;
    const completion = indexed.hydrateMetadata().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf("function"));
    expect(settled).toBe(false);
    releaseRead?.(["---\ntitle: Current\n---\n"]);
    await completion;

    expect(vault.metadataCache.getFileCache(file as InstanceType<typeof TFile>)?.frontmatter?.title)
      .toBe("Current");
  });

  it("cancellation prevents a completed text read from publishing metadata", async () => {
    const { TFile, Vault } = await import("./platform");
    const vault = new Vault("/vault");
    let releaseRead: ((contents: string[]) => void) | undefined;
    fsMock.readDir.mockResolvedValue([{
      name: "recipe.md",
      isDirectory: false,
      mtime: new Date(1),
      size: 10
    }]);
    fsMock.readTextFiles.mockImplementation(() => new Promise<string[]>((resolve) => {
      releaseRead = resolve;
    }));
    const indexed = await vault.indexFolder("recipes");
    const controller = new AbortController();
    const completion = indexed.hydrateMetadata(controller.signal);
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf("function"));

    controller.abort(new DOMException("cancelled", "AbortError"));
    releaseRead?.(["---\ntitle: Stale\n---\n"]);
    await expect(completion).rejects.toMatchObject({ name: "AbortError" });
    const file = vault.getAbstractFileByPath("recipes/recipe.md");
    expect(file).toBeInstanceOf(TFile);
    expect(vault.metadataCache.getFileCache(file as InstanceType<typeof TFile>)).toBeNull();
  });

  it("supersedes an old deferred read when an external modify publishes newer metadata", async () => {
    const { TFile, Vault } = await import("./platform");
    const vault = new Vault("/vault");
    let releaseOldRead: ((contents: string[]) => void) | undefined;
    fsMock.readDir.mockResolvedValue([{
      name: "recipe.md",
      isDirectory: false,
      mtime: new Date(1),
      size: 10
    }]);
    fsMock.readTextFiles.mockImplementation(() => new Promise<string[]>((resolve) => {
      releaseOldRead = resolve;
    }));

    const indexed = await vault.indexFolder("recipes");
    const oldHydration = indexed.hydrateMetadata();
    await vi.waitFor(() => expect(releaseOldRead).toBeTypeOf("function"));
    await expect(vault.applyExternalChange({
      kind: "modify",
      path: "/vault/recipes/recipe.md",
      mtimeMs: 2,
      size: 20,
      content: "---\ntitle: New\n---\n"
    })).resolves.toBe(true);

    releaseOldRead?.(["---\ntitle: Old\n---\n"]);
    await expect(oldHydration).rejects.toThrow("superseded");
    const file = vault.getAbstractFileByPath("recipes/recipe.md");
    expect(file).toBeInstanceOf(TFile);
    expect(vault.metadataCache.getFileCache(file as InstanceType<typeof TFile>)?.frontmatter?.title)
      .toBe("New");
  });

  it("supersedes deferred hydration on direct and optimistic modifications", async () => {
    const { TFile, Vault } = await import("./platform");

    for (const mutate of ["modify", "optimistic"] as const) {
      vi.clearAllMocks();
      pathMock.join.mockImplementation(async (...parts: string[]) => joinPath(...parts));
      fsMock.readDir.mockResolvedValue([{
        name: "recipe.md",
        isDirectory: false,
        mtime: new Date(1),
        size: 10
      }]);
      fsMock.stat.mockResolvedValue({ mtime: 2, size: 20 });
      let releaseOldRead: ((contents: string[]) => void) | undefined;
      fsMock.readTextFiles.mockImplementation(() => new Promise<string[]>((resolve) => {
        releaseOldRead = resolve;
      }));
      const vault = new Vault("/vault");
      const indexed = await vault.indexFolder("recipes");
      const file = vault.getAbstractFileByPath("recipes/recipe.md");
      expect(file).toBeInstanceOf(TFile);
      const oldHydration = indexed.hydrateMetadata();
      await vi.waitFor(() => expect(releaseOldRead).toBeTypeOf("function"));

      const next = "---\ntitle: New\n---\n";
      if (mutate === "modify") {
        await vault.modify(file as InstanceType<typeof TFile>, next);
      } else {
        vault.applyOptimisticContent(file as InstanceType<typeof TFile>, next);
      }
      releaseOldRead?.(["---\ntitle: Old\n---\n"]);
      await expect(oldHydration).rejects.toThrow("superseded");
      expect(vault.metadataCache.getFileCache(file as InstanceType<typeof TFile>)?.frontmatter?.title)
        .toBe("New");
    }
  });

  it("does not resurrect metadata when a deferred read is superseded by remove", async () => {
    const { Vault } = await import("./platform");
    const vault = new Vault("/vault");
    let releaseOldRead: ((contents: string[]) => void) | undefined;
    fsMock.readDir.mockResolvedValue([{
      name: "recipe.md",
      isDirectory: false,
      mtime: new Date(1),
      size: 10
    }]);
    fsMock.readTextFiles.mockImplementation(() => new Promise<string[]>((resolve) => {
      releaseOldRead = resolve;
    }));

    const indexed = await vault.indexFolder("recipes");
    const oldHydration = indexed.hydrateMetadata();
    await vi.waitFor(() => expect(releaseOldRead).toBeTypeOf("function"));
    await expect(vault.applyExternalChange({
      kind: "remove",
      path: "/vault/recipes/recipe.md"
    })).resolves.toBe(true);
    releaseOldRead?.(["---\ntitle: Removed\n---\n"]);

    await expect(oldHydration).rejects.toThrow("superseded");
    expect(vault.metadataCache.snapshot()).not.toHaveProperty("recipes/recipe.md");
  });

  it("a newer full refresh supersedes an older folder hydration", async () => {
    const { TFile, Vault } = await import("./platform");
    const vault = new Vault("/vault");
    let releaseOldRead: ((contents: string[]) => void) | undefined;
    fsMock.readDir.mockImplementation(async (path: string) => {
      if (path === "/vault/recipes") {
        return [{ name: "recipe.md", isDirectory: false, mtime: new Date(1), size: 10 }];
      }
      if (path === "/vault") {
        return [{
          name: "recipes",
          isDirectory: true,
          children: [{ name: "recipe.md", isDirectory: false, mtime: new Date(2), size: 20 }]
        }];
      }
      return [];
    });
    fsMock.readTextFiles
      .mockImplementationOnce(() => new Promise<string[]>((resolve) => {
        releaseOldRead = resolve;
      }))
      .mockResolvedValueOnce(["---\ntitle: New\n---\n"]);

    const indexed = await vault.indexFolder("recipes");
    const oldHydration = indexed.hydrateMetadata();
    await vi.waitFor(() => expect(releaseOldRead).toBeTypeOf("function"));
    await expect(vault.refresh()).resolves.toBe(true);
    releaseOldRead?.(["---\ntitle: Old\n---\n"]);

    await expect(oldHydration).rejects.toThrow("superseded");
    const file = vault.getAbstractFileByPath("recipes/recipe.md");
    expect(file).toBeInstanceOf(TFile);
    expect(vault.metadataCache.getFileCache(file as InstanceType<typeof TFile>)?.frontmatter?.title)
      .toBe("New");
  });

  it("folder re-index clears a removed signature so same-signature re-add hydrates fresh metadata", async () => {
    const { TFile, Vault } = await import("./platform");
    const vault = new Vault("/vault");
    let present = true;
    fsMock.readDir.mockImplementation(async () => present ? [{
      name: "recipe.md",
      isDirectory: false,
      mtime: new Date(1),
      size: 10
    }] : []);
    fsMock.readTextFiles
      .mockResolvedValueOnce(["---\ntitle: Old\n---\n"])
      .mockResolvedValueOnce(["---\ntitle: New\n---\n"]);

    await vault.refreshFolder("recipes");
    present = false;
    await vault.indexFolder("recipes");
    expect(vault.metadataCache.snapshot()).not.toHaveProperty("recipes/recipe.md");

    present = true;
    const readded = await vault.indexFolder("recipes");
    await readded.hydrateMetadata();
    const file = vault.getAbstractFileByPath("recipes/recipe.md");
    expect(file).toBeInstanceOf(TFile);
    expect(fsMock.readTextFiles).toHaveBeenCalledTimes(2);
    expect(vault.metadataCache.getFileCache(file as InstanceType<typeof TFile>)?.frontmatter?.title)
      .toBe("New");
  });

  it("full refresh clears a removed signature so same-signature re-add hydrates fresh metadata", async () => {
    const { TFile, Vault } = await import("./platform");
    const vault = new Vault("/vault");
    let present = true;
    fsMock.readDir.mockImplementation(async () => present ? [{
      name: "recipe.md",
      isDirectory: false,
      mtime: new Date(1),
      size: 10
    }] : []);
    fsMock.readTextFiles
      .mockResolvedValueOnce(["---\ntitle: Old\n---\n"])
      .mockResolvedValueOnce(["---\ntitle: New\n---\n"]);

    await vault.refresh();
    present = false;
    await vault.refresh();
    expect(vault.metadataCache.snapshot()).not.toHaveProperty("recipe.md");

    present = true;
    await vault.refresh();
    const file = vault.getAbstractFileByPath("recipe.md");
    expect(file).toBeInstanceOf(TFile);
    expect(fsMock.readTextFiles).toHaveBeenCalledTimes(2);
    expect(vault.metadataCache.getFileCache(file as InstanceType<typeof TFile>)?.frontmatter?.title)
      .toBe("New");
  });

  it("parses a hydration batch atomically and retries after failure without skipping indexed files", async () => {
    const { TFile, Vault } = await import("./platform");
    const vault = new Vault("/vault");
    fsMock.readDir.mockResolvedValue([
      { name: "a.md", isDirectory: false, mtime: new Date(1), size: 10 },
      { name: "b.md", isDirectory: false, mtime: new Date(1), size: 10 }
    ]);
    fsMock.readTextFiles
      .mockResolvedValueOnce([
        "---\ntitle: A\n---\n",
        "---\ntitle: [\n---\n"
      ])
      .mockResolvedValueOnce([
        "---\ntitle: A\n---\n",
        "---\ntitle: B\n---\n"
      ]);

    const indexed = await vault.indexFolder("recipes");
    await expect(indexed.hydrateMetadata()).rejects.toBeDefined();
    expect(vault.metadataCache.snapshot()).toEqual({});

    await indexed.hydrateMetadata();
    const files = vault.getMarkdownFiles();
    expect(files.every((file) => file instanceof TFile)).toBe(true);
    expect(files.map((file) => vault.metadataCache.getFileCache(file)?.frontmatter?.title))
      .toEqual(["A", "B"]);
  });

});

describe("MetadataCache persisted hydration", () => {
  it("hydrate seeds the cache without firing changed", async () => {
    const { Vault } = await import("./platform");
    const vault = new Vault("/vault");
    const metadataCache = vault.metadataCache;
    const onChanged = vi.fn();
    metadataCache.on("changed", onChanged);

    metadataCache.hydrate({
      "recipes/a.md": { frontmatter: { type: "recipe", title: "A" }, tags: [] }
    });

    expect(onChanged).not.toHaveBeenCalled();
  });

  it("a real read that matches the hydrated snapshot is a silent no-op", async () => {
    const { Vault, TFile } = await import("./platform");
    const vault = new Vault("/vault");
    const metadataCache = vault.metadataCache;

    metadataCache.hydrate({
      "recipes/a.md": { frontmatter: { type: "recipe", title: "A" }, tags: [] }
    });
    const onChanged = vi.fn();
    metadataCache.on("changed", onChanged);

    const file = new TFile("recipes/a.md", "a.md", "/vault/recipes/a.md", { mtime: 1, size: 1 });
    metadataCache.updateFile(file, "---\ntype: recipe\ntitle: A\n---\n");

    expect(onChanged).not.toHaveBeenCalled();
    expect(metadataCache.getFileCache(file)?.frontmatter).toEqual({ type: "recipe", title: "A" });
  });

  it("a real read that differs from the hydrated snapshot fires changed once", async () => {
    const { Vault, TFile } = await import("./platform");
    const vault = new Vault("/vault");
    const metadataCache = vault.metadataCache;

    metadataCache.hydrate({
      "recipes/a.md": { frontmatter: { type: "recipe", title: "Old title" }, tags: [] }
    });
    const onChanged = vi.fn();
    metadataCache.on("changed", onChanged);

    const file = new TFile("recipes/a.md", "a.md", "/vault/recipes/a.md", { mtime: 2, size: 1 });
    metadataCache.updateFile(file, "---\ntype: recipe\ntitle: New title\n---\n");

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(metadataCache.getFileCache(file)?.frontmatter).toEqual({ type: "recipe", title: "New title" });
  });

  it("snapshot mirrors current cache state for persistence", async () => {
    const { Vault, TFile } = await import("./platform");
    const vault = new Vault("/vault");
    const metadataCache = vault.metadataCache;

    const file = new TFile("recipes/a.md", "a.md", "/vault/recipes/a.md", { mtime: 1, size: 1 });
    metadataCache.updateFile(file, "---\ntype: recipe\ntitle: A\n---\n");

    expect(metadataCache.snapshot()).toEqual({
      "recipes/a.md": { frontmatter: { type: "recipe", title: "A" }, tags: [] }
    });
  });
});
