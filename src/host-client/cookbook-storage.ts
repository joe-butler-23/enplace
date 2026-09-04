import { IndexeddbPersistence } from "y-indexeddb";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import type { VaultStorageAdapter } from "./browser-storage";
import {
  deleteCookbookPath, cookbookFiles, cookbookPathConflict, listCookbookPaths,
  normalizeCookbookPath, readCookbookBytes, readCookbookText, walkCookbookFiles, writeCookbookBytes, writeCookbookText,
} from "../cookbook/doc";

export type CookbookStatus = "local-only" | "connecting" | "connected" | "offline";
export type FirstSyncState = "synced" | "unreachable";
export type OpenCookbookOptions = {
  id: string;
  relayUrl: string | null;
  persist?: boolean;
  seed?: (doc: Y.Doc) => Promise<void> | void;
  deferRelayUntilLocalWrite?: boolean;
  onFirstLocalWrite?: () => void;
  WebSocketPolyfill?: typeof WebSocket;
};
export type CookbookConnection = {
  id: string;
  doc: Y.Doc;
  adapter: VaultStorageAdapter;
  relayUrl: string | null;
  hasLocalCopy: boolean;
  firstSync: Promise<FirstSyncState>;
  status: () => CookbookStatus;
  onStatus: (listener: (status: CookbookStatus) => void) => () => void;
  close: () => Promise<void>;
};
const LOCAL_ORIGIN = Symbol("enplace-cookbook-local-write");
const FIRST_SYNC_SAFETY_DEADLINE_MS = 5_000;
const LOCAL_COPY_KEY = "has-local-copy";
// Historical kitchen database prefix stays unchanged so existing IndexedDB data still opens.
const databaseName = (id: string): string => `enplace-kitchen-${id}`;

export async function openCookbook(options: OpenCookbookOptions): Promise<CookbookConnection> {
  const doc = new Y.Doc();
  const persistence = options.persist !== false && typeof indexedDB !== "undefined"
    ? new IndexeddbPersistence(databaseName(options.id), doc) : null;
  if (persistence) await persistence.whenSynced;
  let hasLocalCopy = await persistence?.get(LOCAL_COPY_KEY) === 1;
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
    await options.seed(doc);
    await markLocalCopy();
    hasLocalCopy = true;
  }
  const listeners = new Set<(status: CookbookStatus) => void>();
  const deferredRelay = Boolean(options.relayUrl && options.deferRelayUntilLocalWrite);
  let status: CookbookStatus = options.relayUrl && !deferredRelay ? "connecting" : "local-only";
  let provider: WebsocketProvider | null = null;
  let localWriteListener: ((transaction: Y.Transaction) => void) | null = null;
  let firstSyncDeadline: ReturnType<typeof setTimeout> | null = null;
  let firstSyncSettled = false;
  let firstSyncMarker: Promise<void> | null = null;
  let settleFirstSync!: (state: FirstSyncState) => void;
  let rejectFirstSync!: (reason: unknown) => void;
  const firstSync = new Promise<FirstSyncState>((resolve, reject) => {
    settleFirstSync = resolve;
    rejectFirstSync = reject;
  });
  void firstSync.catch(() => {});
  const settleFirstSyncOnce = (settle: () => void): void => {
    if (firstSyncSettled) return;
    firstSyncSettled = true;
    if (firstSyncDeadline !== null) clearTimeout(firstSyncDeadline);
    firstSyncDeadline = null;
    settle();
  };
  const finishFirstSync = (state: FirstSyncState): void => {
    settleFirstSyncOnce(() => settleFirstSync(state));
  };
  const failFirstSync = (reason: unknown): void => {
    settleFirstSyncOnce(() => rejectFirstSync(reason));
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
    // Relay room names remain the same ids used by the historical kitchen client.
    provider = new WebsocketProvider(options.relayUrl, options.id, doc, {
      connect: false, WebSocketPolyfill: options.WebSocketPolyfill,
    });
    provider.on("sync", (synced: boolean) => {
      if (!synced || firstSyncMarker) return;
      if (hasLocalCopy) {
        finishFirstSync("synced");
        return;
      }
      firstSyncMarker = markLocalCopy();
      void firstSyncMarker.then(() => {
        hasLocalCopy = true;
        finishFirstSync("synced");
      }, failFirstSync);
    });
    provider.on("status", ({ status: next }) => {
      setStatus(next === "disconnected" ? "offline" : next);
      if (next === "disconnected" && !firstSyncMarker) finishFirstSync("unreachable");
    });
    // This deadline only bounds the wait if the transport emits neither sync nor disconnect.
    firstSyncDeadline = setTimeout(() => {
      if (!firstSyncMarker) finishFirstSync("unreachable");
    }, FIRST_SYNC_SAFETY_DEADLINE_MS);
    provider.connect();
  };
  if (!options.relayUrl) finishFirstSync("unreachable");
  if (deferredRelay || options.onFirstLocalWrite) {
    localWriteListener = (transaction: Y.Transaction): void => {
      if (transaction.origin !== LOCAL_ORIGIN || transaction.changed.size === 0) return;
      doc.off("afterTransaction", localWriteListener!);
      localWriteListener = null;
      options.onFirstLocalWrite?.();
      if (deferredRelay) connectRelay();
    };
    doc.on("afterTransaction", localWriteListener);
  }
  if (options.relayUrl && !deferredRelay) connectRelay();
  return {
    id: options.id, doc, adapter, relayUrl: options.relayUrl, hasLocalCopy, firstSync,
    status: () => status,
    onStatus(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() {
      if (closed) return;
      closed = true;
      if (localWriteListener) doc.off("afterTransaction", localWriteListener);
      localWriteListener = null;
      provider?.destroy();
      if (provider) setStatus("offline");
      try {
        if (firstSyncMarker) await firstSyncMarker;
      } finally {
        finishFirstSync("unreachable");
        await persistence?.destroy();
      }
    },
  };
}
