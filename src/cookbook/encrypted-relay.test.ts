import { expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { startRelay } from "../../scripts/cookbook-relay.mjs";
import { openCookbook, type CookbookConnection } from "../host-client/cookbook-storage";
import { newCookbookId, readCookbookText } from "./doc";
import { SEALED_RECORDS } from "./encrypted-provider";
import { cookbookCipher } from "./crypto";
import { readLegacyCookbook } from "./legacy-upgrade";

function received(connection: CookbookConnection, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => finish(new Error("Encrypted relay did not converge before the deadline")), 5000);
    const inspect = (): void => { if (readCookbookText(connection.doc, "PrivateRecipe.md") === expected) finish(); };
    const finish = (error?: Error): void => {
      clearTimeout(deadline);
      connection.doc.off("update", inspect);
      if (error) reject(error); else resolve();
    };
    connection.doc.on("update", inspect);
    inspect();
  });
}

it("persists only ciphertext and restores a cookbook after all clients and the relay restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "enplace-encrypted-relay-"));
  const secret = newCookbookId();
  const cipher = await cookbookCipher(secret);
  const clients: CookbookConnection[] = [];
  let relay = await startRelay({ persist: directory });
  const open = async () => {
    const connection = await openCookbook({ id: secret, relayUrl: relay.url, persist: false,
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket });
    clients.push(connection);
    return connection;
  };
  try {
    const owner = await open();
    const partner = await open();
    const plain = "secret recipe: two private onions";
    await owner.adapter.writeBytes("PrivateRecipe.md", new TextEncoder().encode(plain));
    await received(partner, plain);
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await relay.close();
    const files = await readdir(directory);
    expect(files).toEqual([`${cipher.room}.yjs`]);
    expect(files.join()).not.toContain(secret);
    const persisted = await readFile(join(directory, files[0]));
    expect(persisted.toString()).not.toMatch(/PrivateRecipe|private onions|secret recipe/);
    const wire = new Y.Doc();
    Y.applyUpdate(wire, persisted);
    expect([...wire.share.keys()]).toEqual([SEALED_RECORDS]);
    expect(wire.getMap(SEALED_RECORDS).size).toBeGreaterThan(0);
    wire.destroy();
    relay = await startRelay({ persist: directory });
    const fresh = await open();
    await received(fresh, plain);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

it("downloads a previous cookbook with only a receive request and leaves its stored bytes untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "enplace-previous-relay-"));
  const id = "abcdefghijklmnopqrstuvwxyz";
  const source = new Y.Doc();
  source.getText("previous").insert(0, "historical recipe");
  const original = Y.encodeStateAsUpdate(source);
  source.destroy();
  await writeFile(join(directory, `${id}.yjs`), original);
  const sent: unknown[] = [];
  class ReadOnlySocket extends WebSocket {
    override send(data: Parameters<WebSocket["send"]>[0]): void {
      sent.push(data);
      super.send(data);
    }
  }
  const relay = await startRelay({ persist: directory });
  try {
    const update = await readLegacyCookbook(relay.url, id, new AbortController().signal,
      ReadOnlySocket as unknown as typeof globalThis.WebSocket);
    const downloaded = new Y.Doc();
    Y.applyUpdate(downloaded, update);
    expect(downloaded.getText("previous").toString()).toBe("historical recipe");
    downloaded.destroy();
    expect(sent).toEqual([new Uint8Array([0, 0, 1, 0])]);
    await relay.close();
    expect(new Uint8Array(await readFile(join(directory, `${id}.yjs`)))).toEqual(original);
  } finally {
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  }
});
