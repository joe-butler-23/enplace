import { IndexeddbPersistence } from "y-indexeddb";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import type { VaultStorageAdapter } from "./browser-storage";
import {
  deleteKitchenPath, hasKitchenDirectory, kitchenFiles, listKitchenPaths,
  normalizeKitchenPath, readKitchenBytes, readKitchenText, writeKitchenBytes, writeKitchenText,
} from "../kitchen/doc";

export type KitchenStatus = "local-only" | "connecting" | "connected" | "offline";
export type FirstSyncState = "synced" | "unreachable";
export type OpenKitchenOptions = {
  id: string;
  relayUrl: string | null;
  persist?: boolean;
  seed?: (doc: Y.Doc) => Promise<void> | void;
  deferRelayUntilLocalWrite?: boolean;
  onFirstLocalWrite?: () => void;
  WebSocketPolyfill?: typeof WebSocket;
};
export type KitchenConnection = {
  id: string;
  doc: Y.Doc;
  adapter: VaultStorageAdapter;
  relayUrl: string | null;
  hasLocalCopy: boolean;
  firstSync: Promise<FirstSyncState>;
  status: () => KitchenStatus;
  onStatus: (listener: (status: KitchenStatus) => void) => () => void;
  close: () => Promise<void>;
};
const LOCAL_ORIGIN = Symbol("enplace-kitchen-local-write");
const FIRST_SYNC_SAFETY_DEADLINE_MS = 5_000;
const databaseName = (id: string): string => `enplace-kitchen-${id}`;
const blobPart = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

export async function openKitchen(options: OpenKitchenOptions): Promise<KitchenConnection> {
  const doc = new Y.Doc();
  const persistence = options.persist !== false && typeof indexedDB !== "undefined"
    ? new IndexeddbPersistence(databaseName(options.id), doc) : null;
  if (persistence) await persistence.whenSynced;
  const hasLocalCopy = kitchenFiles(doc).size > 0;
  if (options.seed && !hasLocalCopy) await options.seed(doc);
  const listeners = new Set<(status: KitchenStatus) => void>();
  const deferredRelay = Boolean(options.relayUrl && options.deferRelayUntilLocalWrite);
  let status: KitchenStatus = options.relayUrl && !deferredRelay ? "connecting" : "local-only";
  let provider: WebsocketProvider | null = null;
  let localWriteListener: ((transaction: Y.Transaction) => void) | null = null;
  let firstSyncDeadline: ReturnType<typeof setTimeout> | null = null;
  let firstSyncSettled = false;
  let settleFirstSync!: (state: FirstSyncState) => void;
  const firstSync = new Promise<FirstSyncState>((resolve) => { settleFirstSync = resolve; });
  const finishFirstSync = (state: FirstSyncState): void => {
    if (firstSyncSettled) return;
    firstSyncSettled = true;
    if (firstSyncDeadline !== null) clearTimeout(firstSyncDeadline);
    firstSyncDeadline = null;
    settleFirstSync(state);
  };
  let closed = false;
  const write = (path: string, bytes: Uint8Array): void => writeKitchenBytes(doc, path, bytes, LOCAL_ORIGIN);
  const adapter: VaultStorageAdapter = {
    async readBytes(path) {
      const bytes = readKitchenBytes(doc, path);
      if (bytes === null) throw new Error(`File not found: ${path}`);
      return bytes;
    },
    async writeBytes(path, bytes) { write(path, bytes); },
    async writeNewBytes(rawPath, bytes) {
      const path = normalizeKitchenPath(rawPath);
      if (kitchenFiles(doc).has(path) || hasKitchenDirectory(doc, path)) throw new Error(`A file already exists at ${rawPath}.`);
      write(path, bytes);
    },
    async remove(path, recursive = false) { deleteKitchenPath(doc, path, recursive, LOCAL_ORIGIN); },
    async pathExists(rawPath) {
      const path = normalizeKitchenPath(rawPath);
      return kitchenFiles(doc).has(path) || hasKitchenDirectory(doc, path);
    },
    async walkFiles() {
      return listKitchenPaths(doc).map((path) => {
        const bytes = readKitchenBytes(doc, path) ?? new Uint8Array();
        return { path, file: new File([blobPart(bytes)], path.split("/").pop() ?? path) };
      });
    },
    async fileUrl(path) {
      const bytes = readKitchenBytes(doc, path);
      if (bytes === null) throw new Error(`File not found: ${path}`);
      return URL.createObjectURL(new Blob([blobPart(bytes)]));
    },
    async updateText(path, update) {
      let next = "";
      doc.transact(() => {
        const current = readKitchenText(doc, path) ?? "";
        next = update(current);
        if (next !== current) writeKitchenText(doc, path, next, LOCAL_ORIGIN);
      }, LOCAL_ORIGIN);
      return next;
    },
  };
  const setStatus = (next: KitchenStatus): void => {
    if (status === next) return;
    status = next;
    listeners.forEach((listener) => listener(next));
  };
  const connectRelay = (): void => {
    if (!options.relayUrl || provider || closed) return;
    setStatus("connecting");
    provider = new WebsocketProvider(options.relayUrl, options.id, doc, {
      connect: false, WebSocketPolyfill: options.WebSocketPolyfill,
    });
    provider.on("sync", (synced: boolean) => {
      if (synced) finishFirstSync("synced");
    });
    provider.on("status", ({ status: next }) => {
      setStatus(next === "disconnected" ? "offline" : next);
      if (next === "disconnected") finishFirstSync("unreachable");
    });
    // This deadline only bounds the wait if the transport emits neither sync nor disconnect.
    firstSyncDeadline = setTimeout(() => finishFirstSync("unreachable"), FIRST_SYNC_SAFETY_DEADLINE_MS);
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
      finishFirstSync("unreachable");
      provider?.destroy();
      if (provider) setStatus("offline");
      await persistence?.destroy();
    },
  };
}
