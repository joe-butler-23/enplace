import { routePartykitRequest, type Connection, type ConnectionContext, type WSMessage } from "partyserver";
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
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const ROOM_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

function messageBytes(message: WSMessage): Uint8Array | null {
  if (typeof message === "string") return null;
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}


function hasOpenConnection(connections: Iterable<Connection>, exceptId?: string): boolean {
  return [...connections].some((connection) => connection.id !== exceptId && connection.readyState <= 1);
}

export class Kitchen extends YServer<Env> {
  static callbackOptions = { debounceWait: 1_000, debounceMaxWait: 5_000, timeout: 5_000 };

  async onLoad(): Promise<void> {
    const count = (await this.ctx.storage.get<number>(CHUNK_COUNT_KEY)) ?? 0;
    if (!count) return;
    const keys = Array.from({ length: count }, (_, index) => `chunk:${index}`);
    const chunks = await this.ctx.storage.get<Uint8Array>(keys);
    const parts = keys.map((key) => chunks.get(key)).filter((part): part is Uint8Array => part !== undefined);
    if (parts.length !== count) return;
    const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
    if (byteLength > MAX_DOCUMENT_BYTES) throw new Error("Kitchen document exceeds 16 MiB.");
    const update = new Uint8Array(byteLength);
    let offset = 0;
    for (const part of parts) { update.set(part, offset); offset += part.byteLength; }
    Y.applyUpdate(this.document, update);
  }

  async onSave(): Promise<void> {
    const update = Y.encodeStateAsUpdate(this.document);
    if (update.byteLength > MAX_DOCUMENT_BYTES) {
      // The cap is enforced where the cost is paid once, at save: close every client so the
      // over-limit state is never persisted, rather than re-merging the document per message.
      for (const connection of this.getConnections()) connection.close(1009, "Kitchen exceeds 16 MiB");
      throw new Error("Kitchen document exceeds 16 MiB.");
    }
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

  override async onConnect(connection: Connection, context: ConnectionContext): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    super.onConnect(connection, context);
  }

  override onMessage(connection: Connection, message: WSMessage): void {
    const bytes = messageBytes(message);
    const size = bytes?.byteLength ?? new TextEncoder().encode(message as string).byteLength;
    if (size > MAX_MESSAGE_BYTES) {
      connection.close(1009, "Message exceeds 4 MiB");
      return;
    }
    super.onMessage(connection, message);
  }

  override async onClose(connection: Connection, code: number, reason: string, wasClean: boolean): Promise<void> {
    super.onClose(connection, code, reason, wasClean);
    if (!hasOpenConnection(this.getConnections(), connection.id)) {
      await this.onSave();
      await this.ctx.storage.setAlarm(Date.now() + ROOM_RETENTION_MS);
    }
  }

  override async onAlarm(): Promise<void> {
    if (hasOpenConnection(this.getConnections())) return;
    await this.ctx.storage.deleteAll();
    this.ctx.abort("Kitchen expired after 180 days without a connection");
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
