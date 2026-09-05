import { IndexeddbPersistence } from "y-indexeddb";
import { EncryptedCookbookProvider } from "../cookbook/encrypted-provider";
import * as Y from "yjs";
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
const LOCAL_COPY_KEY = "has-local-copy";
// Historical kitchen database prefix stays unchanged so existing IndexedDB data still opens.
const databaseName = (id: string): string => `enplace-kitchen-${id}`;

// Own database-open errors: y-indexeddb.whenSynced only resolves, even if opening fails.
// Use the same two stores as the atomic first-copy write and y-indexeddb.
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

export async function openCookbook(options: OpenCookbookOptions): Promise<CookbookConnection> {
  const persist = options.persist !== false;
  if (persist && typeof indexedDB === "undefined") throw new Error("Cookbook storage is unavailable in this browser.");
  if (persist) await prepareDatabase(databaseName(options.id), options.signal);
  options.signal?.throwIfAborted();
  const doc = new Y.Doc();
  const persistence = persist ? new IndexeddbPersistence(databaseName(options.id), doc) : null;
  let hasLocalCopy: boolean;
  const cancelInitialization = (): void => {
    void persistence?.destroy().catch(() => {});
    doc.destroy();
  };
  options.signal?.addEventListener("abort", cancelInitialization, { once: true });
  try {
    hasLocalCopy = persistence ? await Promise.all([
      persistence.whenSynced, persistence.get(LOCAL_COPY_KEY),
    ]).then(([, marker]) => marker === 1) : false;
    options.signal?.throwIfAborted();
  } catch (error) {
    void persistence?.destroy().catch(() => {});
    doc.destroy();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", cancelInitialization);
  }
  const markLocalCopy = (): Promise<void> => {
    if (!persistence) return Promise.resolve();
    const db = persistence.db;
    if (!db) return Promise.reject(new Error("Cookbook persistence is not ready."));
    const updatesStoreName = "updates";
    const customStoreName = "custom";
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([updatesStoreName, customStoreName], "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not persist the cookbook."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not persist the cookbook."));
      try {
        transaction.objectStore(updatesStoreName).add(Y.encodeStateAsUpdate(doc));
        transaction.objectStore(customStoreName).put(1, LOCAL_COPY_KEY);
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  };
  if (options.seed && !hasLocalCopy) {
    try {
      await options.seed(doc);
      options.signal?.throwIfAborted();
      await markLocalCopy();
      options.signal?.throwIfAborted();
      hasLocalCopy = true;
    } catch (error) {
      await persistence?.destroy();
      doc.destroy();
      throw error;
    }
  }
  const listeners = new Set<(status: CookbookStatus) => void>();
  const deferredRelay = Boolean(options.relayUrl && options.deferRelayUntilLocalWrite);
  let status: CookbookStatus = options.relayUrl && !deferredRelay ? "connecting" : "local-only";
  let provider: EncryptedCookbookProvider | null = null;
  let localWriteListener: ((transaction: Y.Transaction) => void) | null = null;
  let localCopy: LocalCopyState = hasLocalCopy ? "ready" : "pending";
  let firstCopyWrite: Promise<void> | null = null;
  const copyListeners = new Set<() => void>();
  const syncListeners = new Set<() => void>();
  let remoteSynced = false;
  const setLocalCopy = (next: LocalCopyState): void => {
    if (closed || localCopy === next) return;
    localCopy = next;
    copyListeners.forEach((listener) => listener());
  };
  let closed = false;
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
  const setStatus = (next: CookbookStatus): void => {
    if (status === next) return;
    status = next;
    listeners.forEach((listener) => listener(next));
  };
  const connectRelay = (): void => {
    if (!options.relayUrl || provider || closed) return;
    setStatus("connecting");
    provider = new EncryptedCookbookProvider(options.relayUrl, options.id, doc, {
      WebSocketPolyfill: options.WebSocketPolyfill,
      hasLocalCopy: localCopy === "ready",
      onSync() {
        if (closed) return;
        if (!remoteSynced) {
          remoteSynced = true;
          syncListeners.forEach((listener) => listener());
        }
        if (localCopy === "ready" || firstCopyWrite) return;
        firstCopyWrite = markLocalCopy();
        void firstCopyWrite.then(() => setLocalCopy("ready"), (error) => {
          setLocalCopy(error instanceof Error ? error : new Error("Could not persist the cookbook."));
        });
      },
      onStatus(next) { if (!closed) setStatus(next); },
      onError(error) {
        if (closed) return;
        setLocalCopy(error);
        setStatus("offline");
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("mep-notice", { detail: error.message }));
      },
    });
    provider.connect();
  };
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
      provider?.destroy();
      listeners.clear();
      copyListeners.clear();
      syncListeners.clear();
      // IDBDatabase.close lets active transactions finish; cancellation need not await
      // their acknowledgement. The write handler ignores completion after close.
      try { await persistence?.destroy(); }
      finally { doc.destroy(); }
    },
  };
}
