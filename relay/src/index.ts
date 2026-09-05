import { routePartykitRequest, type Connection, type ConnectionContext, type WSMessage } from "partyserver";
import { YServer } from "y-partyserver";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

/**
 * The Enplace cookbook relay on Cloudflare.
 *
 * One Durable Object per cookbook, named by the cookbook id. `YServer` speaks the y-websocket
 * protocol the encrypted browser projection uses, so a client connects to
 * `wss://<worker>/parties/kitchen/<cookbook-id>`. The document is kept in the object's
 * storage as chunks of one Yjs update, so a cookbook survives every client disconnecting
 * and is there when the next device opens the link.
 *
 * Hibernation: `static options = { hibernate: true }` lets Cloudflare evict this object from
 * memory while idle open sockets stay attached to the runtime, so Durable Object duration is
 * billed only while a message is actually being handled, not for every second a tab is left
 * open. `Server`'s hibernatable API (`webSocketMessage`/`webSocketClose`/`webSocketError`)
 * calls the same `onMessage`/`onClose`/`onError` hooks either way, so no behaviour here
 * depends on which connection manager partyserver picked.
 */

const CHUNK_BYTES = 100_000;
const CHUNK_COUNT_KEY = "chunks";
// Updates that arrive between snapshots are appended as their own rows, so durability costs one
// small write per edit rather than a rewrite of every chunk; a snapshot folds them back in.
const PENDING_PREFIX = "update:";
const PENDING_COUNT_KEY = "pending";
const ROOM_ID = /^e1-[a-f0-9]{64}$/;
const ROOM_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

// Matches the reference Node relay (scripts/cookbook-relay.mjs) unless the platform forces
// something smaller; see docs/relay.md. workerd enforces its own hard WebSocket frame-size
// ceiling around 32 MiB (observed empirically: exactly 32 MiB succeeds, 32 MiB + 1 byte is
// rejected by the transport itself before any application code runs), so the message cap is
// kept safely below that wall instead of matching the reference relay's 32 MiB exactly.
const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_AWARENESS_BYTES = 64 * 1024;
// Unlike the reference relay's 2,000-connection GLOBAL cap (meaningful for a single Node
// process), this is per room: each cookbook is its own Durable Object, and a household sharing
// one cookbook realistically has a handful of devices, not thousands. 64 gives generous
// headroom above that while still bounding the O(n) broadcast fan-out cost of one edit.
const MAX_CONNECTIONS_PER_ROOM = 64;

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

// Per-connection state key tracking which awareness client ids this connection is allowed to
// mutate. Stored via `connection.setState`, which partyserver persists to the WebSocket
// attachment, so ownership survives hibernation just like partyserver's own bookkeeping does.
const AWARENESS_OWNER_KEY = "kitchenAwarenessIds";

type KitchenConnectionState = { [AWARENESS_OWNER_KEY]?: number[] };
type KitchenConnection = Connection<KitchenConnectionState>;

function hasOpenConnection(connections: Iterable<Connection>, exceptId?: string): boolean {
  return [...connections].some((connection) => connection.id !== exceptId && connection.readyState <= 1);
}

function messageAsBytes(message: WSMessage): Uint8Array | null {
  if (typeof message === "string") return null;
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}

function messageByteLength(message: WSMessage): number {
  const bytes = messageAsBytes(message);
  return bytes ? bytes.byteLength : new TextEncoder().encode(message as string).length;
}

function ownedAwarenessIds(connection: KitchenConnection): readonly number[] {
  return connection.state?.[AWARENESS_OWNER_KEY] ?? [];
}

function findAwarenessOwner(
  connections: Iterable<KitchenConnection>,
  clientId: number,
  exceptId: string,
): KitchenConnection | undefined {
  for (const candidate of connections) {
    if (candidate.id === exceptId) continue;
    if (ownedAwarenessIds(candidate).includes(clientId)) return candidate;
  }
  return undefined;
}

type CloseViolation = { code: number; reason: string };

/**
 * Mirrors the reference relay's `validateAwarenessUpdate`: one connection may only introduce
 * or retire one awareness client id, and may never touch another connection's id. Ownership is
 * recorded on success via `connection.setState` so it survives hibernation.
 */
function awarenessViolation(
  connection: KitchenConnection,
  connections: Iterable<KitchenConnection>,
  update: Uint8Array,
  maxAwarenessBytes: number,
): CloseViolation | null {
  if (update.byteLength > maxAwarenessBytes) return { code: 1009, reason: "awareness update too large" };
  const decoder = decoding.createDecoder(update);
  const owned = new Set(ownedAwarenessIds(connection));
  const clientCount = decoding.readVarUint(decoder);
  for (let index = 0; index < clientCount; index += 1) {
    const clientId = decoding.readVarUint(decoder);
    decoding.readVarUint(decoder); // clock
    const stateJson = decoding.readVarString(decoder);
    const owner = findAwarenessOwner(connections, clientId, connection.id);
    if (stateJson === "null") {
      if (owner) return { code: 1008, reason: "cannot remove another connection's awareness" };
      owned.delete(clientId);
    } else {
      if (owner) return { code: 1008, reason: "cannot replace another connection's awareness" };
      owned.add(clientId);
      if (owned.size > 1) return { code: 1008, reason: "one awareness client is allowed per connection" };
    }
  }
  connection.setState((previous) => ({ ...previous, [AWARENESS_OWNER_KEY]: [...owned] }));
  return null;
}

// Historical Kitchen class name is a deployed wire identifier and must not change.
export class Kitchen extends YServer<Env> {
  static options = { hibernate: true };
  static callbackOptions = { debounceWait: 1_000, debounceMaxWait: 5_000 };

  // Serializes storage flushes so a burst of messages triggers one write at a time instead of
  // overlapping `onSave()` calls racing on the same chunk keys.
  #saveChain: Promise<void> = Promise.resolve();
  // Encoded size of the last snapshot plus every update appended since: an upper bound on the
  // document, since applying an update can only add that many bytes, and cheap to keep.
  #documentBytes = 0;
  #pendingCount = 0;

  async onLoad(): Promise<void> {
    const count = (await this.ctx.storage.get<number>(CHUNK_COUNT_KEY)) ?? 0;
    if (count) {
      const keys = Array.from({ length: count }, (_, index) => `chunk:${index}`);
      const chunks = await this.ctx.storage.get<Uint8Array>(keys);
      const parts = keys.map((key) => chunks.get(key)).filter((part): part is Uint8Array => part !== undefined);
      if (parts.length !== count) throw new Error(`Incomplete cookbook snapshot: expected ${count} chunks, found ${parts.length}.`);
      const update = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
      let offset = 0;
      for (const part of parts) { update.set(part, offset); offset += part.byteLength; }
      Y.applyUpdate(this.document, update);
      this.#documentBytes = update.byteLength;
    }
    const pending = await this.ctx.storage.list<Uint8Array>({ prefix: PENDING_PREFIX });
    for (const update of pending.values()) {
      Y.applyUpdate(this.document, update);
      this.#documentBytes += update.byteLength;
    }
    this.#pendingCount = (await this.ctx.storage.get<number>(PENDING_COUNT_KEY)) ?? 0;
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
    const pending = [...(await this.ctx.storage.list({ prefix: PENDING_PREFIX })).keys()];
    await this.ctx.storage.put(entries);
    const stale = Array.from({ length: Math.max(0, previous - count) }, (_, index) => `chunk:${count + index}`);
    if (stale.length || pending.length) await this.ctx.storage.delete([...stale, ...pending, PENDING_COUNT_KEY]);
    this.#documentBytes = update.byteLength;
    this.#pendingCount = 0;
  }

  /** One small row per edit keeps the update durable across hibernation; the next snapshot folds it in. */
  async #append(update: Uint8Array): Promise<void> {
    if (update.byteLength > CHUNK_BYTES) { await this.#flush(); return; }
    const seq = this.#pendingCount;
    this.#pendingCount += 1;
    this.#documentBytes += update.byteLength;
    await this.ctx.storage.put({ [`${PENDING_PREFIX}${String(seq).padStart(9, "0")}`]: update, [PENDING_COUNT_KEY]: this.#pendingCount });
  }

  /** Chains onto any in-flight save so writes for this room are never issued concurrently. */
  async #flush(): Promise<void> {
    const settled = this.#saveChain.catch(() => undefined);
    const current = settled.then(() => this.onSave());
    this.#saveChain = current.catch(() => undefined);
    return current;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const connections = [...this.getConnections()];
      if (connections.length >= MAX_CONNECTIONS_PER_ROOM) {
        return new Response("Cookbook connection limit reached", { status: 503 });
      }
      const chunkCount = (await this.ctx.storage.get<number>(CHUNK_COUNT_KEY)) ?? 0;
      const roomAlreadyExists = chunkCount > 0 || hasOpenConnection(connections);
      if (!roomAlreadyExists) {
        const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";
        const { success } = await this.env.NEW_ROOM_LIMITER.limit({ key: clientIp });
        if (!success) return new Response("Too many new cookbooks from this address, try again shortly", { status: 429 });
      }
    }
    return super.fetch(request);
  }

  override async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (messageByteLength(message) > MAX_MESSAGE_BYTES) {
      connection.close(1009, "message too large");
      return;
    }

    const kitchenConnection = connection as KitchenConnection;
    let applied: Uint8Array | null = null;
    const bytes = messageAsBytes(message);
    if (bytes) {
      try {
        const peek = decoding.createDecoder(bytes);
        const messageType = decoding.readVarUint(peek);
        if (messageType === MESSAGE_SYNC) {
          const syncType = decoding.readVarUint(peek);
          if (syncType === syncProtocol.messageYjsSyncStep2 || syncType === syncProtocol.messageYjsUpdate) {
            const update = decoding.readVarUint8Array(peek);
            if (this.#documentBytes + update.byteLength > MAX_DOCUMENT_BYTES) {
              connection.close(1009, "cookbook document too large");
              return;
            }
            applied = update;
          }
        } else if (messageType === MESSAGE_AWARENESS) {
          const update = decoding.readVarUint8Array(peek);
          const violation = awarenessViolation(kitchenConnection, this.getConnections<KitchenConnectionState>(), update, MAX_AWARENESS_BYTES);
          if (violation) {
            connection.close(violation.code, violation.reason);
            return;
          }
        }
      } catch {
        // Malformed frame: fall through and let the base implementation raise its own,
        // identically-shaped parse error instead of duplicating that handling here.
      }
    }

    await super.onMessage(connection, message);
    if (applied) await this.#append(applied);
  }

  override async onConnect(connection: Connection, context: ConnectionContext): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    super.onConnect(connection, context);
  }


  override async onClose(connection: Connection, code: number, reason: string, wasClean: boolean): Promise<void> {
    super.onClose(connection, code, reason, wasClean);
    if (!hasOpenConnection(this.getConnections(), connection.id)) {
      await this.#flush();
      await this.ctx.storage.setAlarm(Date.now() + ROOM_RETENTION_MS);
    }
  }

  override async onAlarm(): Promise<void> {
    if (hasOpenConnection(this.getConnections())) return;
    await this.ctx.storage.deleteAll();
    this.ctx.abort("Cookbook expired after 180 days without a connection");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/parties\/kitchen\/([^/]+)$/.exec(url.pathname);
    if (url.pathname === "/") return new Response("Enplace cookbook relay", { status: 200 });
    if (!match || !ROOM_ID.test(match[1])) return new Response("Not found", { status: 404 });
    return (await routePartykitRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
