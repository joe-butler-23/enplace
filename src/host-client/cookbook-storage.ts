import { IndexeddbPersistence } from "y-indexeddb";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { cookbookCipher } from "../cookbook/crypto";
import { EncryptedCookbookBridge } from "../cookbook/encrypted-provider";
import type { VaultStorageAdapter } from "./browser-storage";
import {
  deleteCookbookPath, cookbookFiles, cookbookPathConflict, listCookbookPaths,
  normalizeCookbookPath, readCookbookBytes, readCookbookText, walkCookbookFiles, writeCookbookBytes, writeCookbookText,
} from "../cookbook/doc";

export type CookbookStatus = "local-only" | "connecting" | "connected" | "offline";
export type LocalCopyState = "pending" | "ready" | Error;
export type OpenCookbookOptions = {
  id: string;
  relayUrl: string | null;
  persist?: boolean;
  seed?: (doc: Y.Doc) => Promise<void> | void;
  deferRelayUntilLocalWrite?: boolean;
  onFirstLocalWrite?: () => void;
  WebSocketPolyfill?: typeof WebSocket;
  signal?: AbortSignal;
};
export type CookbookConnection = {
  id: string;
  doc: Y.Doc;
  adapter: VaultStorageAdapter;
  relayUrl: string | null;
  localCopy: () => LocalCopyState;
  onLocalCopy: (listener: () => void) => () => void;
  remoteSynced: () => boolean;
  onRemoteSync: (listener: () => void) => () => void;
  status: () => CookbookStatus;
  onStatus: (listener: (status: CookbookStatus) => void) => () => void;
  publish: () => void;
  close: () => Promise<void>;
};
const LOCAL_ORIGIN = Symbol("enplace-cookbook-local-write");
/** The persisted copy is the encrypted projection, named by the public room so no secret is stored. */
export const cookbookDatabaseName = (room: string): string => `enplace-cookbook-${room}`;

// Own database-open errors: y-indexeddb.whenSynced only resolves, even if opening fails.
// Use the same two stores as y-indexeddb.
async function prepareDatabase(name: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name);
    let finished = false;
    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = (): void => finish(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    request.onupgradeneeded = () => {
      request.result.createObjectStore("updates", { autoIncrement: true });
      request.result.createObjectStore("custom");
    };
    request.onerror = () => finish(request.error ?? new Error("Could not open cookbook storage."));
    request.onblocked = () => finish(new Error("Cookbook storage is blocked by another tab. Close it and reload."));
    request.onsuccess = () => {
      const db = request.result;
      const valid = db.objectStoreNames.contains("updates") && db.objectStoreNames.contains("custom");
      db.close();
      finish(valid ? undefined : new Error("Cookbook storage is missing its required stores."));
    };
  });
}

/** Commits the whole wire state in one transaction and drops the entries it supersedes. Readiness waits for this. */
function commit(persistence: IndexeddbPersistence): Promise<void> {
  const db = persistence.db;
  if (!db) return Promise.reject(new Error("Cookbook persistence is not ready."));
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("updates", "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not persist the cookbook."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Could not persist the cookbook."));
    const store = transaction.objectStore("updates");
    const added = store.add(Y.encodeStateAsUpdate(persistence.doc));
    added.onsuccess = () => store.delete(IDBKeyRange.upperBound(added.result, true));
  });
}

export async function openCookbook(options: OpenCookbookOptions): Promise<CookbookConnection> {
  const persist = options.persist !== false;
  if (persist && typeof indexedDB === "undefined") throw new Error("Cookbook storage is unavailable in this browser.");
  const cipher = await cookbookCipher(options.id);
  const name = cookbookDatabaseName(cipher.room);
  if (persist) await prepareDatabase(name, options.signal);
  options.signal?.throwIfAborted();
  const doc = new Y.Doc();
  const wire = new Y.Doc();
  const persistence = persist ? new IndexeddbPersistence(name, wire) : null;
  let closed = false;
  let localCopy: LocalCopyState = "pending";
  const copyListeners = new Set<() => void>();
  const setLocalCopy = (next: LocalCopyState): void => {
    if (closed || localCopy === next) return;
    localCopy = next;
    copyListeners.forEach((listener) => listener());
  };
  const listeners = new Set<(status: CookbookStatus) => void>();
  const deferredRelay = Boolean(options.relayUrl && options.deferRelayUntilLocalWrite);
  let status: CookbookStatus = options.relayUrl && !deferredRelay ? "connecting" : "local-only";
  const setStatus = (next: CookbookStatus): void => {
    if (closed || status === next) return;
    status = next;
    listeners.forEach((listener) => listener(next));
  };
  const bridge = new EncryptedCookbookBridge(doc, wire, cipher, (error) => {
    if (closed) return;
    setLocalCopy(error);
    setStatus("offline");
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("mep-notice", { detail: error.message }));
  });
  let provider: WebsocketProvider | null = null;
  const destroy = (): void => {
    bridge.destroy();
    provider?.destroy();
    void persistence?.destroy().catch(() => {});
    wire.destroy();
    doc.destroy();
  };
  options.signal?.addEventListener("abort", destroy, { once: true });
  try {
    if (persistence) await persistence.whenSynced;
    await bridge.settled();
    options.signal?.throwIfAborted();
    // One snapshot record makes even an empty cookbook distinguishable from one never downloaded.
    if (options.seed && bridge.records.size === 0) {
      await options.seed(doc);
      await bridge.compact();
      if (persistence) await commit(persistence);
      options.signal?.throwIfAborted();
    }
  } catch (error) {
    destroy();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", destroy);
  }
  if (bridge.records.size) localCopy = "ready";
  // A first copy arriving from the relay is ready once it is committed, not once it is decoded.
  let firstCopy: Promise<void> | null = null;
  bridge.records.observe(() => {
    if (localCopy !== "pending" || firstCopy || !bridge.records.size) return;
    firstCopy = bridge.settled().then(() => persistence ? commit(persistence) : undefined);
    void firstCopy.then(() => setLocalCopy("ready"), (error) => {
      setLocalCopy(error instanceof Error ? error : new Error("Could not persist the cookbook."));
    });
  });
  const syncListeners = new Set<() => void>();
  let remoteSynced = false;
  const write = (path: string, bytes: Uint8Array): void => writeCookbookBytes(doc, path, bytes, LOCAL_ORIGIN);
  const adapter: VaultStorageAdapter = {
    async readBytes(path) {
      const bytes = readCookbookBytes(doc, path);
      if (bytes === null) throw new Error(`File not found: ${path}`);
      return bytes;
    },
    async writeBytes(path, bytes) { write(path, bytes); },
    async writeNewBytesBatch(entries, existing = "skip") {
      const occupied = new Set(listCookbookPaths(doc));
      const rawPaths = new Set(cookbookFiles(doc).keys());
      const writable: Array<readonly [string, Uint8Array]> = [];
      for (const [rawPath, bytes] of entries) {
        const path = normalizeCookbookPath(rawPath);
        if (!path) throw new Error("Cannot write the folder root.");
        if (occupied.has(path)) {
          if (existing === "reject") throw new Error(`A file already exists at ${rawPath}.`);
          continue;
        }
        const conflict = cookbookPathConflict(occupied, path);
        if (!conflict && rawPaths.has(path)) throw new Error(`Cannot import ${rawPath}: its raw path is hidden by projection.`);
        if (conflict) throw new Error(`Cannot import ${rawPath}: it conflicts with file ${conflict}.`);
        occupied.add(path);
        writable.push([path, bytes]);
      }
      doc.transact(() => {
        for (const [path, bytes] of writable) write(path, bytes);
      }, LOCAL_ORIGIN);
      return writable.length;
    },
    async remove(path, recursive = false) { deleteCookbookPath(doc, path, recursive, LOCAL_ORIGIN); },
    async walkFiles() {
      return walkCookbookFiles(doc);
    },
    async updateText(path, update) {
      let next = "";
      doc.transact(() => {
        const current = readCookbookText(doc, path) ?? "";
        next = update(current);
        if (next !== current) writeCookbookText(doc, path, next, LOCAL_ORIGIN);
      }, LOCAL_ORIGIN);
      return next;
    },
  };
  const connectRelay = (): void => {
    if (!options.relayUrl || provider || closed) return;
    setStatus("connecting");
    // The wire document syncs by state vector, so a reconnect exchanges only the records
    // each side lacks; offline edits are already sealed records waiting in it.
    provider = new WebsocketProvider(options.relayUrl, cipher.room, wire, {
      connect: false, disableBc: true, WebSocketPolyfill: options.WebSocketPolyfill,
    });
    provider.awareness.setLocalState(null);
    provider.on("status", ({ status: next }: { status: string }) => {
      setStatus(next === "connected" ? "connected" : next === "connecting" ? "connecting" : "offline");
    });
    // An empty relay room is not a synced cookbook; a linked device waits for a record.
    const checkSynced = (): void => {
      if (!provider?.synced || remoteSynced || !bridge.records.size) return;
      void bridge.settled().then(() => {
        if (closed || remoteSynced) return;
        remoteSynced = true;
        syncListeners.forEach((listener) => listener());
        if (bridge.wasteful()) void bridge.compact();
      }, () => {});
    };
    provider.on("sync", checkSynced);
    bridge.records.observe(checkSynced);
    provider.connect();
  };
  // A phone back from the lock screen or a dead network often holds a half-open socket that
  // never closes; y-websocket would notice only after thirty silent seconds. Replacing the
  // connection on return costs one differential handshake and makes the next tick immediate.
  const wake = (): void => {
    if (closed || !provider || (typeof document !== "undefined" && document.visibilityState !== "visible")) return;
    provider.disconnect();
    provider.connect();
  };
  if (typeof window !== "undefined") {
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
  }
  let localWriteListener: ((transaction: Y.Transaction) => void) | null = null;
  let publicationPending = deferredRelay || Boolean(options.onFirstLocalWrite);
  const publish = (): void => {
    if (!publicationPending) return;
    publicationPending = false;
    if (localWriteListener) doc.off("afterTransaction", localWriteListener);
    localWriteListener = null;
    options.onFirstLocalWrite?.();
    if (deferredRelay) connectRelay();
  };
  if (publicationPending) {
    localWriteListener = (transaction: Y.Transaction): void => {
      if (transaction.origin === LOCAL_ORIGIN && transaction.changed.size > 0) publish();
    };
    doc.on("afterTransaction", localWriteListener);
  }
  if (options.relayUrl && !deferredRelay) connectRelay();
  return {
    id: options.id, doc, adapter, relayUrl: options.relayUrl,
    localCopy: () => localCopy,
    onLocalCopy(listener) { copyListeners.add(listener); return () => copyListeners.delete(listener); },
    remoteSynced: () => remoteSynced,
    onRemoteSync(listener) { syncListeners.add(listener); return () => syncListeners.delete(listener); },
    status: () => status,
    onStatus(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    publish,
    async close() {
      if (closed) return;
      closed = true;
      if (localWriteListener) doc.off("afterTransaction", localWriteListener);
      localWriteListener = null;
      if (typeof window !== "undefined") {
        document.removeEventListener("visibilitychange", wake);
        window.removeEventListener("online", wake);
      }
      bridge.destroy();
      provider?.destroy();
      listeners.clear();
      copyListeners.clear();
      syncListeners.clear();
      // IDBDatabase.close lets active transactions finish; cancellation need not await
      // their acknowledgement.
      try { await persistence?.destroy(); }
      finally { wire.destroy(); doc.destroy(); }
    },
  };
}
