import { routePartykitRequest } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";

/**
 * The Enplace kitchen relay on Cloudflare.
 *
 * One Durable Object per kitchen, named by the kitchen id. `YServer` speaks the y-websocket
 * protocol the app and `mep mirror` already use, so a client connects to
 * `wss://<worker>/parties/kitchen/<kitchen-id>`. The document is kept in the object's
 * storage as chunks of one Yjs update, so a kitchen survives every client disconnecting
 * and is there when the next device opens the link.
 */

const CHUNK_BYTES = 100_000;
const CHUNK_COUNT_KEY = "chunks";
const ROOM_ID = /^[a-z2-7]{26}$/;

export class Kitchen extends YServer<Env> {
  static callbackOptions = { debounceWait: 1_000, debounceMaxWait: 5_000, timeout: 5_000 };

  async onLoad(): Promise<void> {
    const count = (await this.ctx.storage.get<number>(CHUNK_COUNT_KEY)) ?? 0;
    if (!count) return;
    const keys = Array.from({ length: count }, (_, index) => `chunk:${index}`);
    const chunks = await this.ctx.storage.get<Uint8Array>(keys);
    const parts = keys.map((key) => chunks.get(key)).filter((part): part is Uint8Array => part !== undefined);
    if (parts.length !== count) return;
    const update = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) { update.set(part, offset); offset += part.byteLength; }
    Y.applyUpdate(this.document, update);
  }

  async onSave(): Promise<void> {
    const update = Y.encodeStateAsUpdate(this.document);
    const entries: Record<string, Uint8Array | number> = {};
    let count = 0;
    for (let offset = 0; offset < update.byteLength; offset += CHUNK_BYTES) {
      entries[`chunk:${count}`] = update.slice(offset, offset + CHUNK_BYTES);
      count += 1;
    }
    entries[CHUNK_COUNT_KEY] = count;
    const previous = (await this.ctx.storage.get<number>(CHUNK_COUNT_KEY)) ?? 0;
    await this.ctx.storage.put(entries);
    if (previous > count) {
      await this.ctx.storage.delete(Array.from({ length: previous - count }, (_, index) => `chunk:${count + index}`));
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/parties\/kitchen\/([^/]+)$/.exec(url.pathname);
    if (url.pathname === "/") return new Response("Enplace kitchen relay", { status: 200 });
    if (!match || !ROOM_ID.test(match[1])) return new Response("Not found", { status: 404 });
    return (await routePartykitRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
