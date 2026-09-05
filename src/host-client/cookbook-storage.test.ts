import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startRelay } from "../../scripts/cookbook-relay.mjs";
import { openCookbook, type CookbookConnection, type CookbookStatus } from "./cookbook-storage";
import { listCookbookPaths, observeCookbook, readCookbookBytes, readCookbookText, writeCookbookText, newCookbookId } from "../cookbook/doc";

const WebSocketPolyfill = WebSocket as unknown as typeof globalThis.WebSocket;

function waitForStatus(connection: CookbookConnection, expected: CookbookStatus): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => {};
    const finish = (): void => {
      unsubscribe();
      resolve();
    };
    unsubscribe = connection.onStatus((status) => {
      if (status === expected) finish();
    });
    if (connection.status() === expected) finish();
  });
}

function waitForText(connection: CookbookConnection, path: string, expected: string): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      if (readCookbookText(connection.doc, path) !== expected) return;
      connection.doc.off("update", finish);
      resolve();
    };
    connection.doc.on("update", finish);
    finish();
  });
}

const connections: CookbookConnection[] = [];
let relay: Awaited<ReturnType<typeof startRelay>>;

beforeAll(async () => { relay = await startRelay({ host: "0.0.0.0" }); });
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
});
afterAll(async () => { await relay.close(); });

async function open(options: Partial<Parameters<typeof openCookbook>[0]> = {}): Promise<CookbookConnection> {
  const connection = await openCookbook({
    id: newCookbookId(),
    relayUrl: null,
    persist: false,
    ...options,
  });
  connections.push(connection);
  return connection;
}

describe("cookbook storage adapter", () => {
  it("seeds an empty local cookbook and exposes implied directories", async () => {
    const seed = vi.fn((doc) => writeCookbookText(doc, "recipes/soup.md", "# Soup\n"));
    const connection = await open({ seed });

    expect(seed).toHaveBeenCalledOnce();
    await expect(connection.adapter.readBytes("recipes/soup.md"))
      .resolves.toEqual(new TextEncoder().encode("# Soup\n"));
    expect((await connection.adapter.walkFiles()).map(({ path }) => path)).toEqual(["recipes/soup.md"]);
    expect(connection.status()).toBe("local-only");
  });

  it("enumerates sorted export bytes without changing text or binary content", async () => {
    const { adapter } = await open();
    await adapter.writeBytes("notes.md", new Uint8Array([0xff, 0x0a]));
    await adapter.writeBytes("images/dish.webp", new Uint8Array([0x00, 0xff, 0x7f]));

    const files = await adapter.walkFiles();

    expect(files.map(({ path }) => path)).toEqual(["images/dish.webp", "notes.md"]);
    expect(files[0].bytes).toEqual(new Uint8Array([0x00, 0xff, 0x7f]));
    expect(files[1].bytes).toEqual(new TextEncoder().encode("�\n"));
  });

  it("exposes file-like errors and mutation semantics", async () => {
    const { adapter } = await open();
    await expect(adapter.readBytes("missing.md")).rejects.toThrow("File not found: missing.md");
    await expect(adapter.writeBytes("/", new Uint8Array())).rejects.toThrow("Invalid folder path");

    await adapter.writeBytes("recipes/a.md", new TextEncoder().encode("# A"));
    await expect(adapter.remove("recipes")).rejects.toThrow("Directory is not empty: recipes");
    await adapter.remove("recipes", true);
  });

  it("writes a multi-file import in one transaction and skips existing paths", async () => {
    const connection = await open();
    await connection.adapter.writeBytes("recipes/existing.md", new TextEncoder().encode("# Existing"));
    const changes: string[][] = [];
    const stop = observeCookbook(connection.doc, (paths) => changes.push([...paths].sort()));

    const imported = await connection.adapter.writeNewBytesBatch([
      ["recipes/existing.md", new TextEncoder().encode("overwrite")],
      ["recipes/a.md", new TextEncoder().encode("# A")],
      ["images/a.webp", new Uint8Array([1, 2, 3])],
      ["recipes/a.md", new TextEncoder().encode("duplicate")],
    ]);
    stop();

    expect(imported).toBe(2);
    expect(changes).toEqual([["images/a.webp", "recipes/a.md"]]);
    expect(readCookbookText(connection.doc, "recipes/existing.md")).toBe("# Existing");
    expect(readCookbookText(connection.doc, "recipes/a.md")).toBe("# A");
    expect(readCookbookBytes(connection.doc, "images/a.webp")).toEqual(new Uint8Array([1, 2, 3]));
    await expect(connection.adapter.writeNewBytesBatch([
      ["partial.bin", new Uint8Array([9])], ["recipes/a.md", new Uint8Array([8])],
    ], "reject")).rejects.toThrow("already exists");
    expect(listCookbookPaths(connection.doc)).not.toContain("partial.bin");
  });

  it.each([
    ["file then child", ["node", "node/child"]],
    ["child then file", ["node/child", "node"]],
  ])("rejects an atomic %s batch", async (_name, paths) => {
    const connection = await open();
    await expect(connection.adapter.writeNewBytesBatch([
      ["unrelated.bin", new Uint8Array([9])],
      [paths[0], new Uint8Array([1])], [paths[1], new Uint8Array([2])],
    ])).rejects.toThrow("conflicts with file");
    expect(listCookbookPaths(connection.doc)).toEqual([]);
  });


  it("applies text update functions to live content in one transaction", async () => {
    const connection = await open();
    await connection.adapter.writeBytes(
      "Shopping.md",
      new TextEncoder().encode("- [ ] milk\n- [ ] eggs\n"),
    );
    writeCookbookText(connection.doc, "Shopping.md", "- [ ] milk\n- [x] eggs\n");

    const saved = await connection.adapter.updateText(
      "Shopping.md",
      (current) => current.replace("- [ ] milk", "- [x] milk"),
    );

    expect(saved).toBe("- [x] milk\n- [x] eggs\n");
    expect(readCookbookText(connection.doc, "Shopping.md")).toBe(saved);
  });

  it("does not transact when a text update returns the current content", async () => {
    const connection = await open();
    await connection.adapter.writeBytes("Plan.md", new TextEncoder().encode("## Marked\n"));
    const updates = vi.fn();
    connection.doc.on("update", updates);

    await expect(connection.adapter.updateText("Plan.md", (current) => current))
      .resolves.toBe("## Marked\n");
    expect(updates).not.toHaveBeenCalled();
  });
});

describe("cookbook relay", () => {
  it("converges concurrent live text updates without an event bridge", async () => {
    const id = newCookbookId();
    const port = new URL(relay.url).port;
    const left = await open({ id, relayUrl: `ws://127.0.0.1:${port}`, WebSocketPolyfill });
    const right = await open({ id, relayUrl: `ws://127.0.0.2:${port}`, WebSocketPolyfill });
    await Promise.all([waitForStatus(left, "connected"), waitForStatus(right, "connected")]);

    const base = "- [ ] milk\n- [ ] eggs\n";
    await left.adapter.writeBytes("Shopping.md", new TextEncoder().encode(base));
    await waitForText(right, "Shopping.md", base);

    const merged = "- [x] milk\n- [x] eggs\n";
    await Promise.all([
      left.adapter.updateText("Shopping.md", (current) => current.replace("- [ ] milk", "- [x] milk")),
      right.adapter.updateText("Shopping.md", (current) => current.replace("- [ ] eggs", "- [x] eggs")),
    ]);

    await Promise.all([
      waitForText(left, "Shopping.md", merged),
      waitForText(right, "Shopping.md", merged),
    ]);
    expect(readCookbookText(left.doc, "Shopping.md")).toBe(merged);
    expect(readCookbookText(right.doc, "Shopping.md")).toBe(merged);
  });
});


describe("sealing failures", () => {
  it("rejects the next adapter write once sealing fails and recovers once the cipher works again", async () => {
    let broken = true;
    const connection = await open({
      wrapCipher: (cipher) => ({
        ...cipher,
        async seal(id, update) {
          if (broken) throw new Error("stub seal failure");
          return cipher.seal(id, update);
        },
      }),
    });

    // The write itself resolves — the doc mutation is synchronous — but the seal it triggers
    // fails in the background, which cookbook-storage still reports through onError.
    const sealFailed = new Promise<void>((resolve) => {
      const stop = connection.onLocalCopy(() => {
        if (connection.localCopy() instanceof Error) { stop(); resolve(); }
      });
    });
    await connection.adapter.writeBytes("b.md", new TextEncoder().encode("second"));
    await sealFailed;

    // Only now does the next write reject, with a message and without touching the doc.
    await expect(connection.adapter.writeBytes("c.md", new TextEncoder().encode("third")))
      .rejects.toThrow(/cannot be saved/i);
    expect(readCookbookText(connection.doc, "c.md")).toBeNull();
    await expect(connection.adapter.updateText("c.md", (current) => current)).rejects.toThrow(/cannot be saved/i);
    await expect(connection.adapter.remove("b.md")).rejects.toThrow(/cannot be saved/i);

    broken = false;
    // Fixing the cipher clears the failure: the still-queued edit and the new write both seal.
    await expect(connection.adapter.writeBytes("d.md", new TextEncoder().encode("fourth"))).resolves.toBeUndefined();
    expect(readCookbookText(connection.doc, "b.md")).toBe("second");
    expect(readCookbookText(connection.doc, "d.md")).toBe("fourth");
  });
});

describe("local readiness and remote synchronization", () => {
  it("does not claim durable readiness when browser storage is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(openCookbook({ id: newCookbookId(), relayUrl: null })).rejects.toThrow("storage is unavailable");
  });
  it("keeps seeded readiness separate from the first remote sync used by cover backfill", async () => {
    const connection = await open({
      id: newCookbookId(), relayUrl: relay.url, WebSocketPolyfill,
      deferRelayUntilLocalWrite: true,
      seed: () => {},
    });
    expect(connection.localCopy()).toBe("ready");
    expect(connection.remoteSynced()).toBe(false);
    const synced = new Promise<void>((resolve) => {
      const stop = connection.onRemoteSync(() => { stop(); resolve(); });
    });
    await connection.adapter.writeBytes("Plan.md", new TextEncoder().encode("# Plan"));
    await synced;
    expect(connection.remoteSynced()).toBe(true);
    expect(connection.localCopy()).toBe("ready");
  });
});
