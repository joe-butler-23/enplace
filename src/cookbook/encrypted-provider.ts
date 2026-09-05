import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { cookbookCipher, newEnvelopeId, type CookbookCipher } from "./crypto";

export const SEALED_RECORDS = "sealed-v1";
const COMPACT_RECORD_COUNT = 64;

/**
 * The wire document is only a disposable encrypted projection of the cookbook.
 * Yjs merges its record map too. Compaction replaces precisely the records already
 * decrypted into a snapshot; a concurrent unseen record is never deleted. Two
 * concurrent snapshots remain separate records and their inner Yjs updates merge.
 */
export class EncryptedCookbookBridge {
  readonly records: Y.Map<Uint8Array>;
  private readonly seen = new Set<string>();
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private failure: Error | null = null;

  constructor(readonly doc: Y.Doc, readonly wire: Y.Doc, private cipher: CookbookCipher,
    private onError: (error: Error) => void) {
    this.records = wire.getMap(SEALED_RECORDS);
    this.records.observe(this.receive);
    doc.on("update", this.publish);
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.pending = this.pending.then(async () => {
      if (!this.closed && !this.failure) await work();
    }).catch((error) => {
      if (this.closed || this.failure) return;
      this.failure = error instanceof Error ? error : new Error("Could not secure the cookbook.");
      this.onError(this.failure);
    });
    return this.pending;
  }

  private decrypt = async (): Promise<void> => {
    const entries = [...this.records].filter(([id]) => !this.seen.has(id));
    // Authenticate the complete batch before applying any of it to the cookbook.
    const updates = await Promise.all(entries.map(([id, sealed]) => this.cipher.open(id, sealed)));
    if (this.closed) return;
    if (updates.length) Y.applyUpdate(this.doc, Y.mergeUpdates(updates), this);
    for (const [id] of entries) this.seen.add(id);
    for (const id of this.seen) if (!this.records.has(id)) this.seen.delete(id);
  };

  private receive = (): void => { void this.enqueue(this.decrypt); };

  private store = async (update: Uint8Array, replaces: string[] = []): Promise<void> => {
    const id = newEnvelopeId();
    const sealed = await this.cipher.seal(id, update);
    if (this.closed) return;
    this.seen.add(id);
    this.wire.transact(() => {
      this.records.set(id, sealed);
      for (const previous of replaces) this.records.delete(previous);
    }, this);
  };

  private compact = async (): Promise<void> => {
    await this.decrypt();
    if (this.closed) return;
    const replaces = [...this.records.keys()].filter((id) => this.seen.has(id));
    const snapshot = Y.encodeStateAsUpdate(this.doc);
    await this.store(snapshot, replaces);
  };

  private publish = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return;
    void this.enqueue(async () => {
      if (this.records.size >= COMPACT_RECORD_COUNT) await this.compact();
      else await this.store(update);
    });
  };

  /** Initial sync also publishes local/offline state, without deleting unseen remote records. */
  async sync(): Promise<void> {
    await this.enqueue(this.compact);
    if (this.failure) throw this.failure;
  }

  async settled(): Promise<void> {
    let pending: Promise<void>;
    do { pending = this.pending; await pending; } while (pending !== this.pending);
    if (this.failure) throw this.failure;
  }

  destroy(): void {
    this.closed = true;
    this.records.unobserve(this.receive);
    this.doc.off("update", this.publish);
  }
}

export type EncryptedProviderOptions = {
  WebSocketPolyfill?: typeof WebSocket;
  hasLocalCopy: boolean;
  onSync: () => void;
  onStatus: (status: "connecting" | "connected" | "offline") => void;
  onError: (error: Error) => void;
};

export class EncryptedCookbookProvider {
  private provider: WebsocketProvider | null = null;
  private bridge: EncryptedCookbookBridge | null = null;
  private wire: Y.Doc | null = null;
  private closed = false;
  private localWrites = false;
  private attemptSync: (() => void) | null = null;

  private localWrite = (_update: Uint8Array, origin: unknown): void => {
    if (origin === this.bridge) return;
    this.localWrites = true;
    this.attemptSync?.();
  };

  constructor(private url: string, private secret: string, private doc: Y.Doc,
    private options: EncryptedProviderOptions) {
    // Own local edits before asynchronous key derivation starts; the first
    // authenticated snapshot includes edits made while crypto is initializing.
    doc.on("update", this.localWrite);
  }

  connect(): void {
    void this.start().catch((error) => { if (!this.closed) this.fail(error); });
  }

  private fail = (error: unknown): void => {
    this.options.onError(error instanceof Error ? error : new Error("Could not secure the cookbook."));
    this.destroy();
  };

  private async start(): Promise<void> {
    const cipher = await cookbookCipher(this.secret);
    if (this.closed) return;
    const wire = this.wire = new Y.Doc();
    const bridge = this.bridge = new EncryptedCookbookBridge(this.doc, wire, cipher, this.fail);
    const provider = this.provider = new WebsocketProvider(this.url, cipher.room, wire, {
      connect: false, disableBc: true, WebSocketPolyfill: this.options.WebSocketPolyfill,
    });
    // No presence/cursor data is needed; the transport has no plaintext awareness payload.
    provider.awareness.setLocalState(null);
    let synchronizing = false;
    let notified = false;
    const sync = (): void => {
      if (!provider.synced || this.closed || synchronizing || notified) return;
      // An empty relay response is not an initialized empty cookbook. A fresh linked
      // device waits for an authenticated record; a cached/seeded owner can publish.
      if (!this.options.hasLocalCopy && !this.localWrites && bridge.records.size === 0) return;
      synchronizing = true;
      void bridge.sync().then(() => {
        synchronizing = false;
        if (!this.closed && provider.synced) {
          notified = true;
          this.options.onSync();
        }
      }, this.fail);
    };
    this.attemptSync = sync;
    bridge.records.observe(sync);
    provider.on("sync", (synced: boolean) => {
      if (!synced) notified = false;
      else sync();
    });
    provider.on("status", ({ status }: { status: string }) => {
      if (!this.closed) this.options.onStatus(status === "connected" ? "connected" : status === "connecting" ? "connecting" : "offline");
    });
    provider.connect();
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.doc.off("update", this.localWrite);
    this.attemptSync = null;
    this.bridge?.destroy();
    this.provider?.destroy();
    this.wire?.destroy();
  }
}
