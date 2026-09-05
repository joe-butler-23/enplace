import * as Y from "yjs";
import { newEnvelopeId, type CookbookCipher } from "./crypto";

export const SEALED_RECORDS = "sealed-v1";
/** Records at or under this size are edits, not imports; only these are folded together. */
const SMALL_RECORD_BYTES = 4_096;
const FOLD_AT = 32;
/** The log is rewritten as one snapshot only when it holds more than twice the live cookbook. */
const SNAPSHOT_SLACK_BYTES = 64 * 1024;

/**
 * The wire document is only a disposable encrypted projection of the cookbook, and it is the
 * copy every device persists: the plaintext cookbook is rebuilt from it in memory. Yjs merges
 * its record map. Folding and snapshots replace precisely the records already decrypted here;
 * a concurrent unseen record is never deleted, and two concurrent snapshots remain separate
 * records whose inner Yjs updates merge.
 */
export class EncryptedCookbookBridge {
  readonly records: Y.Map<Uint8Array>;
  private readonly plain = new Map<string, Uint8Array>();
  private queue: Uint8Array[] = [];
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private failure: Error | null = null;

  constructor(readonly doc: Y.Doc, readonly wire: Y.Doc, private cipher: CookbookCipher,
    private onError: (error: Error) => void) {
    this.records = wire.getMap(SEALED_RECORDS);
    this.records.observe(this.receive);
    doc.on("update", this.publish);
    this.receive();
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
    const entries = [...this.records].filter(([id]) => !this.plain.has(id));
    // Authenticate the complete batch before applying any of it to the cookbook.
    const updates = await Promise.all(entries.map(([id, sealed]) => this.cipher.open(id, sealed)));
    if (this.closed) return;
    if (updates.length) Y.applyUpdate(this.doc, Y.mergeUpdates(updates), this);
    entries.forEach(([id], index) => this.plain.set(id, updates[index]));
    for (const id of this.plain.keys()) if (!this.records.has(id)) this.plain.delete(id);
  };

  private receive = (): void => { void this.enqueue(this.decrypt); };

  private store = async (update: Uint8Array, replaces: string[] = []): Promise<void> => {
    const id = newEnvelopeId();
    const sealed = await this.cipher.seal(id, update);
    if (this.closed) return;
    this.plain.set(id, update);
    for (const previous of replaces) this.plain.delete(previous);
    this.wire.transact(() => {
      this.records.set(id, sealed);
      for (const previous of replaces) this.records.delete(previous);
    }, this);
  };

  /** Edits made while a seal is in flight leave as one record. */
  private drain = async (): Promise<void> => {
    if (!this.queue.length) return;
    const updates = this.queue;
    this.queue = [];
    await this.store(updates.length === 1 ? updates[0] : Y.mergeUpdates(updates));
    const small = [...this.records].filter(([id, sealed]) => this.plain.has(id) && sealed.byteLength <= SMALL_RECORD_BYTES).map(([id]) => id);
    if (small.length >= FOLD_AT) await this.store(Y.mergeUpdates(small.map((id) => this.plain.get(id)!)), small);
  };

  private publish = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return;
    this.queue.push(update);
    void this.enqueue(this.drain);
  };

  /** Replaces every record read here with one snapshot of the live cookbook. */
  compact(): Promise<void> {
    return this.enqueue(async () => {
      await this.decrypt();
      if (this.closed) return;
      await this.store(Y.encodeStateAsUpdate(this.doc), [...this.plain.keys()]);
    });
  }

  /** True when deleted or superseded content makes the log more than twice the live cookbook. */
  wasteful(): boolean {
    let log = 0;
    for (const sealed of this.records.values()) log += sealed.byteLength;
    return log > 2 * Y.encodeStateAsUpdate(this.doc).byteLength + SNAPSHOT_SLACK_BYTES;
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
