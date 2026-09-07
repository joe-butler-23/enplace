import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startRelay } from "../../scripts/cookbook-relay.mjs";
import { openCookbook, type CookbookConnection, type OpenCookbookOptions } from "../host-client/cookbook-storage";
import { commitFrame, readCommitFrame } from "./commit-protocol";
import { newCookbookId, readCookbookText, writeCookbookText } from "./doc";

const encoder = new TextEncoder();
const clients: CookbookConnection[] = [];
const relays: Array<Awaited<ReturnType<typeof startRelay>>> = [];
const directories: string[] = [];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(relays.splice(0).map(relay => relay.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function relay(persist = true) {
  const directory = persist ? await mkdtemp(join(tmpdir(), "enplace-session-")) : null;
  if (directory) directories.push(directory);
  const server = await startRelay({ persist: directory });
  relays.push(server);
  return { server, directory };
}
async function open(url: string, id: string, options: Partial<OpenCookbookOptions> = {}) {
  const client = await openCookbook({ id, relayUrl: url, persist: false, WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket, ...options });
  clients.push(client);
  return client;
}
async function publish(url: string, id = newCookbookId()) {
  const client = await open(url, id, { seed: () => {} });
  await client.ready();
  await client.commit();
  return client;
}

it("waits for encryption and a durable receipt before close; a fresh peer restores the write after relay restart", async () => {
  const { server, directory } = await relay();
  const owner = await publish(server.url);
  const entered = deferred(); const release = deferred();
  const command = await open(server.url, owner.id, { wrapCipher: cipher => ({ ...cipher,
    seal: async (id, bytes) => { entered.resolve(); await release.promise; return cipher.seal(id, bytes); },
  }) });
  await command.ready();
  await command.adapter.writeBytes("recipe.md", encoder.encode("# Survives process exit\n"));
  const unsealed = expect(command.commit({ timeoutMs: 30 })).rejects.toThrow("timed out");
  try {
    await entered.promise;
    expect(command.remoteSynced()).toBe(true);
    await unsealed;
  } finally { release.resolve(); }
  await command.commit();
  await Promise.all([command.close(), owner.close()]);
  await server.close();
  const restarted = await startRelay({ persist: directory }); relays.push(restarted);
  const fresh = await open(restarted.url, owner.id);
  await fresh.ready();
  expect(readCookbookText(fresh.doc, "recipe.md")).toBe("# Survives process exit\n");
});

it("accepts a published authenticated empty cookbook and rejects an unknown empty room or unreadable records", async () => {
  const { server } = await relay();
  const owner = await publish(server.url);
  const empty = await open(server.url, owner.id);
  await empty.ready();
  expect(await empty.adapter.walkFiles()).toEqual([]);
  const unknown = await open(server.url, newCookbookId());
  await expect(unknown.ready()).rejects.toThrow("no authenticated cookbook");
  const corrupt = await open(server.url, owner.id, { wrapCipher: cipher => ({ ...cipher, open: async () => { throw new Error("tampered"); } }) });
  await expect(corrupt.ready()).rejects.toThrow("authentication failed");
});

it("rejects a seal failure instead of certifying the previous synced state", async () => {
  const { server } = await relay(); const owner = await publish(server.url);
  const command = await open(server.url, owner.id, { wrapCipher: cipher => ({ ...cipher, seal: async () => { throw new Error("injected seal failure"); } }) });
  await command.ready();
  await command.adapter.writeBytes("failed.md", encoder.encode("not encrypted"));
  await expect(command.commit()).rejects.toThrow("injected seal failure");
});

it("recovers retained encrypted updates after a transient seal failure without repeating the mutation", async () => {
  const { server } = await relay(); const owner = await publish(server.url);
  let fail = true;
  const command = await open(server.url, owner.id, { wrapCipher: cipher => ({ ...cipher, seal: async (id, bytes) => {
    if (fail) throw new Error("temporary seal failure");
    return cipher.seal(id, bytes);
  } }) });
  await command.ready();
  await command.adapter.writeBytes("retry.md", encoder.encode("one retained edit"));
  await expect(command.commit()).rejects.toThrow("temporary seal failure");
  fail = false;
  await command.ready(); await command.commit();
  expect(command.status()).toBe("connected");
  const fresh = await open(server.url, owner.id); await fresh.ready();
  expect(readCookbookText(fresh.doc, "retry.md")).toBe("one retained edit");
});

it("rejects a nonpersistent relay instead of calling an in-memory broadcast durable", async () => {
  const { server } = await relay(false);
  const command = await open(server.url, newCookbookId(), { seed: () => {} });
  await command.ready();
  await expect(command.commit()).rejects.toThrow("could not durably store");
});

it("rejects an actual local relay storage failure", async () => {
  const { server, directory } = await relay(); const owner = await publish(server.url);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await rm(directory!, { recursive: true, force: true });
    await owner.adapter.writeBytes("unsaved.md", encoder.encode("cannot reach storage"));
    await expect(owner.commit()).rejects.toThrow("could not durably store");
    expect(errors).toHaveBeenCalled();
    await mkdir(directory!, { recursive: true });
    // No further document mutation: retry the retained failed snapshot itself.
    await expect(owner.commit()).resolves.toBeUndefined();
  } finally { errors.mockRestore(); }
});

it("ignores a receipt for another request and enforces the commit deadline", async () => {
  const { server } = await relay(); const owner = await publish(server.url);
  class WrongReceipt extends WebSocket {
    override send(data: Parameters<WebSocket["send"]>[0]): void {
      const request = data instanceof Uint8Array ? readCommitFrame(data) : null;
      if (!request) { super.send(data); return; }
      this.emit("message", commitFrame("0".repeat(32), "committed"), true);
    }
  }
  const command = await open(server.url, owner.id, { WebSocketPolyfill: WrongReceipt as unknown as typeof globalThis.WebSocket });
  await command.ready();
  await expect(command.commit({ timeoutMs: 30 })).rejects.toThrow("timed out");
});

it("cancels a pending receipt and releases its socket listeners", async () => {
  const { server } = await relay(); const owner = await publish(server.url);
  const sent = deferred(); let socket: WebSocket;
  class HeldReceipt extends WebSocket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) { super(...args); socket = this; }
    override send(data: Parameters<WebSocket["send"]>[0]): void {
      if (data instanceof Uint8Array && readCommitFrame(data)) { sent.resolve(); return; }
      super.send(data);
    }
  }
  const command = await open(server.url, owner.id, { WebSocketPolyfill: HeldReceipt as unknown as typeof globalThis.WebSocket });
  await command.ready();
  const messages = socket!.listenerCount("message"); const closes = socket!.listenerCount("close");
  const controller = new AbortController();
  const committing = command.commit({ signal: controller.signal });
  const rejected = expect(committing).rejects.toThrow("cancelled by caller");
  await sent.promise; controller.abort(new Error("cancelled by caller")); await rejected;
  expect(socket!.listenerCount("message")).toBe(messages);
  expect(socket!.listenerCount("close")).toBe(closes);
});

it("rejects a disconnected commit; a new handshake can commit retained updates on the same session", async () => {
  const { server } = await relay(); const owner = await publish(server.url);
  let drop = true;
  class DisconnectReceipt extends WebSocket {
    override send(data: Parameters<WebSocket["send"]>[0]): void {
      if (drop && data instanceof Uint8Array && readCommitFrame(data)) { drop = false; this.close(); return; }
      super.send(data);
    }
  }
  const command = await open(server.url, owner.id, { WebSocketPolyfill: DisconnectReceipt as unknown as typeof globalThis.WebSocket });
  await command.ready();
  await command.adapter.writeBytes("reconnected.md", encoder.encode("retained"));
  await expect(command.commit()).rejects.toThrow("disconnected before its receipt");
  await command.ready(); await command.commit(); await command.close();
  const fresh = await open(server.url, owner.id); await fresh.ready();
  expect(readCookbookText(fresh.doc, "reconnected.md")).toBe("retained");
});

it("groups synchronous domain writes into one guarded local transaction", async () => {
  const { server } = await relay(); const command = await publish(server.url);
  let writes = 0; command.doc.on("update", () => { writes += 1; });
  const result = await command.mutate(() => {
    writeCookbookText(command.doc, "one.md", "one");
    writeCookbookText(command.doc, "two.md", "two");
    return "changed";
  });
  expect(result).toBe("changed"); expect(writes).toBe(1);
  await command.commit(); await command.close();
  await expect(command.mutate(() => "should not run")).rejects.toThrow("closed");
});
