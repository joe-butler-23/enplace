import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebsocketProvider } from "y-websocket";
import { WebSocket } from "ws";
import * as Y from "yjs";
import {
  deleteKitchenPath,
  kitchenLink,
  newKitchenId,
  readKitchenBytes,
  readKitchenText,
  writeKitchenBytes,
  writeKitchenText,
} from "../src/kitchen/doc";
import { startRelay } from "../scripts/kitchen-relay.mjs";
import { execute } from "./index";

const folders: string[] = [];
const providers: WebsocketProvider[] = [];
const documents: Y.Doc[] = [];
const controllers: AbortController[] = [];
const mirrors: Promise<string>[] = [];
let relayServer: Awaited<ReturnType<typeof startRelay>>;
let relay: string;

async function folder(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "mep-mirror-"));
  folders.push(value);
  return value;
}

async function syncedClient(kitchen: string): Promise<{ doc: Y.Doc; provider: WebsocketProvider }> {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(relay, kitchen, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  documents.push(doc);
  providers.push(provider);
  if (!provider.synced) {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => finish(new Error("client did not sync")), 5_000);
      const onSync = (synced: boolean) => { if (synced) finish(); };
      const finish = (error?: Error): void => {
        clearTimeout(deadline);
        provider.off("sync", onSync);
        if (error) reject(error); else resolve();
      };
      provider.on("sync", onSync);
    });
  }
  return { doc, provider };
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  await expect.poll(async () => {
    try { await assertion(); return true; }
    catch { return false; }
  }, { timeout: 5_000, interval: 20 }).toBe(true);
}

function startMirror(
  root: string,
  kitchen: string,
  options: { log?: (line: string) => void; now?: Date } = {},
): AbortController {
  const controller = new AbortController();
  controllers.push(controller);
  mirrors.push(execute([
    "mirror", "--folder", root, "--kitchen", kitchen, "--relay", relay,
  ], { ...options, signal: controller.signal }));
  return controller;
}

beforeAll(async () => {
  relayServer = await startRelay();
  relay = relayServer.url;
});

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.all(mirrors.splice(0));
  for (const provider of providers.splice(0)) provider.destroy();
  for (const doc of documents.splice(0)) doc.destroy();
  await Promise.all(folders.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

afterAll(async () => {
  await relayServer.close();
});

describe("mep mirror", () => {
  it("requires an explicit or environment relay URL", async () => {
    const root = await folder();
    const previous = process.env.ENPLACE_RELAY_URL;
    delete process.env.ENPLACE_RELAY_URL;
    try {
      await expect(execute([
        "mirror", "--folder", root, "--kitchen", newKitchenId(), "--once",
      ])).rejects.toThrow("mirror needs --relay <wss-url> or ENPLACE_RELAY_URL");
    } finally {
      if (previous === undefined) delete process.env.ENPLACE_RELAY_URL;
      else process.env.ENPLACE_RELAY_URL = previous;
    }
  });

  it("pushes a folder recipe into an empty kitchen with --once", async () => {
    const root = await folder();
    await mkdir(path.join(root, "recipes"));
    const markdown = "# Soup\n\n## Ingredients\n- lentils\n";
    await writeFile(path.join(root, "recipes", "soup.md"), markdown);
    const kitchen = newKitchenId();
    const client = await syncedClient(kitchen);

    await execute([
      "mirror", "--folder", root, "--kitchen", kitchenLink("https://enplace.test", kitchen),
      "--relay", relay, "--once",
    ]);

    await waitFor(() => expect(readKitchenText(client.doc, "recipes/soup.md")).toBe(markdown));
  });

  it("writes a second client's Shopping.md change to disk in continuous mode", async () => {
    const root = await folder();
    const kitchen = newKitchenId();
    const client = await syncedClient(kitchen);
    startMirror(root, kitchen);

    writeKitchenText(client.doc, "Shopping.md", "# Shopping\n- [ ] onions\n");

    const shopping = path.join(root, "Shopping.md");
    await waitFor(async () => {
      await expect(readFile(shopping, "utf8")).resolves.toBe("# Shopping\n- [ ] onions\n");
    });

    deleteKitchenPath(client.doc, "Shopping.md");
    await waitFor(async () => {
      await expect(readFile(shopping)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("updates the kitchen when a mirrored disk file is edited", async () => {
    const root = await folder();
    const kitchen = newKitchenId();
    const client = await syncedClient(kitchen);
    startMirror(root, kitchen);
    writeKitchenText(client.doc, "recipes/pie.md", "# Pie\n");
    await waitFor(async () => {
      await expect(readFile(path.join(root, "recipes", "pie.md"), "utf8")).resolves.toBe("# Pie\n");
    });

    const recipe = path.join(root, "recipes", "pie.md");
    await writeFile(recipe, "# Better Pie\n");
    await waitFor(() => expect(readKitchenText(client.doc, "recipes/pie.md")).toBe("# Better Pie\n"));

    await rm(recipe);
    await waitFor(() => expect(readKitchenText(client.doc, "recipes/pie.md")).toBeNull());
  }, 12_000);

  it("refuses a document write through a symlink outside the mirror root", async () => {
    const root = await folder();
    const outside = await folder();
    await symlink(outside, path.join(root, "recipes"));
    const kitchen = newKitchenId();
    const client = await syncedClient(kitchen);
    writeKitchenText(client.doc, "recipes/soup.md", "# Soup\n");
    const verifier = await syncedClient(kitchen);
    expect(readKitchenText(verifier.doc, "recipes/soup.md")).toBe("# Soup\n");

    await expect(execute([
      "mirror", "--folder", root, "--kitchen", kitchen, "--relay", relay, "--once",
    ])).rejects.toThrow("refusing to mirror symbolic link: recipes/soup.md");
    await expect(readFile(path.join(outside, "soup.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a differing local binary file and lets the kitchen version win", async () => {
    const root = await folder();
    await writeFile(path.join(root, "cover.webp"), "local image");
    const kitchen = newKitchenId();
    const client = await syncedClient(kitchen);
    writeKitchenBytes(client.doc, "cover.webp", new TextEncoder().encode("shared image"));
    const verifier = await syncedClient(kitchen);
    expect(new TextDecoder().decode(readKitchenBytes(verifier.doc, "cover.webp")!)).toBe("shared image");

    const logs: string[] = [];
    await execute([
      "mirror", "--folder", root, "--kitchen", kitchen, "--relay", relay, "--once",
    ], { now: new Date(2026, 8, 10, 12, 34, 56), log: (line) => logs.push(line) });

    expect(logs).toEqual([
      "wrote cover.webp; preserved local copy as cover.local-20260910-123456.webp\n",
    ]);
    await expect(readFile(path.join(root, "cover.webp"), "utf8")).resolves.toBe("shared image");
    await expect(readFile(path.join(root, "cover.local-20260910-123456.webp"), "utf8"))
      .resolves.toBe("local image");
  });

  it("merges unknown initial text as peer content instead of overwriting it", async () => {
    const root = await folder();
    await writeFile(path.join(root, "notes.md"), "local starting point\n");
    const kitchen = newKitchenId();
    const client = await syncedClient(kitchen);
    writeKitchenText(client.doc, "notes.md", "kitchen starting point\n");
    const verifier = await syncedClient(kitchen);
    expect(readKitchenText(verifier.doc, "notes.md")).toBe("kitchen starting point\n");
    const logs: string[] = [];

    await execute([
      "mirror", "--folder", root, "--kitchen", kitchen, "--relay", relay, "--once",
    ], { log: (line) => logs.push(line) });

    const merged = "local starting point\nkitchen starting point\n";
    await expect(readFile(path.join(root, "notes.md"), "utf8")).resolves.toBe(merged);
    await waitFor(() => expect(readKitchenText(client.doc, "notes.md")).toBe(merged));
    expect(logs).toContain("merged local changes with kitchen for notes.md\n");
  });

  it("merges an immediate local text edit with a remote text edit", async () => {
    const root = await folder();
    const kitchen = newKitchenId();
    const client = await syncedClient(kitchen);
    const logs: string[] = [];
    startMirror(root, kitchen, { log: (line) => logs.push(line) });
    const target = path.join(root, "notes.md");
    const base = "first: base\nsecond: base\n";
    writeKitchenText(client.doc, "notes.md", base);
    await waitFor(async () => expect(await readFile(target, "utf8")).toBe(base));

    const local = "first: local\nsecond: base\n";
    const remote = "first: base\nsecond: remote\n";
    const merged = "first: local\nsecond: remote\n";
    await writeFile(target, local);
    writeKitchenText(client.doc, "notes.md", remote);

    await waitFor(() => expect(readKitchenText(client.doc, "notes.md")).toBe(merged));
    await waitFor(async () => expect(await readFile(target, "utf8")).toBe(merged));
    expect(logs).toContain("merged local changes with kitchen for notes.md\n");
  });

  it("keeps both overlapping text edits in the disk file and kitchen", async () => {
    const root = await folder();
    const kitchen = newKitchenId();
    const client = await syncedClient(kitchen);
    const logs: string[] = [];
    startMirror(root, kitchen, { log: (line) => logs.push(line) });
    const target = path.join(root, "notes.md");
    const base = "first: base\nsecond: base\n";
    writeKitchenText(client.doc, "notes.md", base);
    await waitFor(async () => expect(await readFile(target, "utf8")).toBe(base));

    await writeFile(target, "first: disk\nsecond: base\n");
    writeKitchenText(client.doc, "notes.md", "first: kitchen\nsecond: base\n");
    const merged = "<<<<<<< this device\nfirst: disk\n=======\nfirst: kitchen\n>>>>>>>>\nsecond: base\n";

    await waitFor(async () => {
      expect(await readFile(target, "utf8")).toBe(merged);
      expect(readKitchenText(client.doc, "notes.md")).toBe(merged);
    });
    expect(logs.filter((line) => line.includes("conflict"))).toEqual([
      "merged local changes with kitchen for notes.md; kept 1 conflict\n",
    ]);
    expect((await readdir(root)).filter((name) => name.includes(".local-"))).toEqual([]);
  });

  it("preserves a local edit when a remote delete wins the path", async () => {
    const root = await folder();
    const kitchen = newKitchenId();
    const client = await syncedClient(kitchen);
    const logs: string[] = [];
    startMirror(root, kitchen, {
      now: new Date(2026, 8, 10, 12, 34, 56),
      log: (line) => logs.push(line),
    });
    const target = path.join(root, "Shopping.md");
    writeKitchenText(client.doc, "Shopping.md", "shared\n");
    await waitFor(async () => expect(await readFile(target, "utf8")).toBe("shared\n"));

    await writeFile(target, "local unsynced change\n");
    deleteKitchenPath(client.doc, "Shopping.md");

    await waitFor(async () => {
      await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
      const copies = (await readdir(root)).filter((name) => name.startsWith("Shopping.local-"));
      expect(copies).toHaveLength(1);
      await expect(readFile(path.join(root, copies[0]), "utf8")).resolves.toBe("local unsynced change\n");
    });
    expect(logs).toContain(
      "deleted Shopping.md; preserved local copy as Shopping.local-20260910-123456.md\n",
    );
  });

  it("restores a remote update when the local file was concurrently deleted", async () => {
    const root = await folder();
    const kitchen = newKitchenId();
    const client = await syncedClient(kitchen);
    const logs: string[] = [];
    startMirror(root, kitchen, { log: (line) => logs.push(line) });
    const target = path.join(root, "notes.md");
    writeKitchenText(client.doc, "notes.md", "shared\n");
    await waitFor(async () => expect(await readFile(target, "utf8")).toBe("shared\n"));

    await unlink(target);
    writeKitchenText(client.doc, "notes.md", "remote replacement\n");

    await waitFor(async () => expect(await readFile(target, "utf8")).toBe("remote replacement\n"));
    expect(logs).toContain("restored notes.md; local deletion conflicted with kitchen change\n");
  });

  it("merges divergent files when two continuous mirrors start together", async () => {
    const left = await folder();
    const right = await folder();
    await writeFile(path.join(left, "same.md"), "left addition\n");
    await writeFile(path.join(right, "same.md"), "right addition\n");
    const kitchen = newKitchenId();
    const client = await syncedClient(kitchen);

    startMirror(left, kitchen);
    startMirror(right, kitchen);

    await waitFor(() => {
      const text = readKitchenText(client.doc, "same.md") ?? "";
      expect(text).toContain("left addition");
      expect(text).toContain("right addition");
    });
    await waitFor(async () => {
      const shared = readKitchenText(client.doc, "same.md");
      expect(await readFile(path.join(left, "same.md"), "utf8")).toBe(shared);
      expect(await readFile(path.join(right, "same.md"), "utf8")).toBe(shared);
    });
  }, 12_000);

  it("resolves a symlink mirror root to its physical directory", async () => {
    const physical = await folder();
    const parent = await folder();
    const linked = path.join(parent, "linked-root");
    await symlink(physical, linked, "dir");
    const kitchen = newKitchenId();
    const client = await syncedClient(kitchen);
    writeKitchenText(client.doc, "inside.md", "relay bytes\n");
    const verifier = await syncedClient(kitchen);
    expect(readKitchenText(verifier.doc, "inside.md")).toBe("relay bytes\n");
    const logs: string[] = [];

    await execute([
      "mirror", "--folder", linked, "--kitchen", kitchen, "--relay", relay, "--once",
    ], { log: (line) => logs.push(line) });

    await expect(readFile(path.join(physical, "inside.md"), "utf8")).resolves.toBe("relay bytes\n");
    expect(logs.some((line) => line.includes(`resolved mirror folder ${linked} to ${physical}`))).toBe(true);
  });
});
