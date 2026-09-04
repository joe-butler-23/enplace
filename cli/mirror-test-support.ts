import { expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebsocketProvider } from "y-websocket";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { startRelay } from "../scripts/cookbook-relay.mjs";

export class MirrorTestFixture {
  readonly folders: string[] = [];
  readonly providers: WebsocketProvider[] = [];
  readonly documents: Y.Doc[] = [];
  relay = "";
  private relayServer?: Awaited<ReturnType<typeof startRelay>>;

  async start(): Promise<void> {
    this.relayServer = await startRelay();
    this.relay = this.relayServer.url;
  }

  async folder(): Promise<string> {
    const value = await mkdtemp(path.join(os.tmpdir(), "mep-mirror-"));
    this.folders.push(value);
    return value;
  }

  async client(cookbook: string): Promise<{ doc: Y.Doc; provider: WebsocketProvider }> {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(this.relay, cookbook, doc, {
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket, disableBc: true,
    });
    this.documents.push(doc);
    this.providers.push(provider);
    if (!provider.synced) await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => finish(new Error("client did not sync")), 5_000);
      const onSync = (synced: boolean) => { if (synced) finish(); };
      const onClosed = () => finish(new Error("relay closed before client sync"));
      const finish = (error?: Error): void => {
        clearTimeout(deadline);
        provider.off("sync", onSync);
        provider.off("closed", onClosed);
        if (error) reject(error); else resolve();
      };
      provider.on("sync", onSync);
      provider.on("closed", onClosed);
      if (provider.synced) finish();
    });
    return { doc, provider };
  }

  async cleanup(): Promise<void> {
    for (const provider of this.providers.splice(0)) provider.destroy();
    for (const doc of this.documents.splice(0)) doc.destroy();
    await Promise.all(this.folders.splice(0).map((value) => rm(value, { recursive: true, force: true })));
  }

  async close(): Promise<void> {
    await this.cleanup();
    await this.relayServer?.close();
  }
}

export async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  await expect.poll(async () => {
    try { await assertion(); return true; } catch { return false; }
  }, { timeout: 5_000, interval: 20 }).toBe(true);
}
