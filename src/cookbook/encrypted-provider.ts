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
 *
 * Every record authenticates independently. One that fails to open is quarantined by id: it is
 * skipped on every later decrypt, never applied to the cookbook, and — because folding and
 * snapshots only ever replace ids already in `plain` — never deleted, so another device can
 * still inspect it. A quarantined record never blocks a good record in the same batch, and
 * never blocks later local publishing or remote applying.
 */
export class EncryptedCookbookBridge {
  readonly records: Y.Map<Uint8Array>;
  private readonly plain = new Map<string, Uint8Array>();
  private readonly quarantine = new Set<string>();
  private readonly integrityListeners = new Set<(count: number) => void>();
  private queue: Uint8Array[] = [];
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  /** Set while the last attempt to seal local edits failed; cleared the next time one succeeds. */
  private sealError: Error | null = null;

  constructor(readonly doc: Y.Doc, readonly wire: Y.Doc, private cipher: CookbookCipher,
    private onError: (error: Error) => void) {
    this.records = wire.getMap(SEALED_RECORDS);
    this.records.observe(this.receive);
    doc.on("update", this.publish);
    this.receive();
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.pending = this.pending.then(async () => {
      if (!this.closed) await work();
    }).catch((error) => {
      if (this.closed) return;
      this.onError(error instanceof Error ? error : new Error("Could not secure the cookbook."));
    });
    return this.pending;
  }

  private notifyIntegrity(): void {
    const count = this.quarantine.size;
    this.integrityListeners.forEach((listener) => listener(count));
  }

  /** Authenticates one record. A record that fails to open is quarantined, never applied. */
  private authenticate = async (id: string, sealed: Uint8Array): Promise<Uint8Array | null> => {
    try {
      return await this.cipher.open(id, sealed);
    } catch {
      if (!this.quarantine.has(id)) {
        this.quarantine.add(id);
        this.notifyIntegrity();
      }
      return null;
    }
  };

  private decrypt = async (): Promise<void> => {
    const entries = [...this.records].filter(([id]) => !this.plain.has(id) && !this.quarantine.has(id));
    // Every record authenticates on its own; one failing never withholds the others.
    const opened = await Promise.all(entries.map(([id, sealed]) => this.authenticate(id, sealed)));
    if (this.closed) return;
    const updates: Uint8Array[] = [];
    entries.forEach(([id], index) => {
      const update = opened[index];
      if (update !== null) { this.plain.set(id, update); updates.push(update); }
    });
    if (updates.length) Y.applyUpdate(this.doc, Y.mergeUpdates(updates), this);
    for (const id of this.plain.keys()) if (!this.records.has(id)) this.plain.delete(id);
    for (const id of this.quarantine) {
      if (!this.records.has(id)) { this.quarantine.delete(id); this.notifyIntegrity(); }
    }
  };

  private receive = (): void => { void this.enqueue(this.decrypt); };

  private store = async (update: Uint8Array, replaces: string[] = []): Promise<void> => {
    const id = newEnvelopeId();
    let sealed: Uint8Array;
    try {
      sealed = await this.cipher.seal(id, update);
    } catch (error) {
      this.sealError = error instanceof Error ? error : new Error("Could not secure the cookbook.");
      throw this.sealError;
    }
    this.sealError = null;
    if (this.closed) return;
    this.plain.set(id, update);
    for (const previous of replaces) this.plain.delete(previous);
    this.wire.transact(() => {
      this.records.set(id, sealed);
      for (const previous of replaces) this.records.delete(previous);
    }, this);
  };

  /** Edits made while a seal is in flight leave as one record. A failed seal keeps its updates queued. */
  private drain = async (): Promise<void> => {
    if (!this.queue.length) return;
    const updates = this.queue;
    this.queue = [];
    try {
      await this.store(updates.length === 1 ? updates[0] : Y.mergeUpdates(updates));
    } catch (error) {
      this.queue = [...updates, ...this.queue];
      throw error;
    }
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

  /** The number of records currently unreadable (quarantined). Zero means every record authenticated. */
  integrity(): number {
    return this.quarantine.size;
  }

  onIntegrity(listener: (count: number) => void): () => void {
    this.integrityListeners.add(listener);
    return () => this.integrityListeners.delete(listener);
  }

  /** Non-null while the last seal attempt failed. Callers that must not accept a write while
   * sealing is broken should call `retrySeal()` first and reject if it still throws. */
  sealFailure(): Error | null {
    return this.sealError;
  }

  /** Retries whatever local edits are still waiting to be sealed and throws if that retry fails.
   * Nothing queued means nothing is at risk of being silently lost, so that clears the flag too. */
  async retrySeal(): Promise<void> {
    if (!this.queue.length) { this.sealError = null; return; }
    await this.enqueue(this.drain);
    if (this.sealError) throw this.sealError;
  }

  async settled(): Promise<void> {
    let pending: Promise<void>;
    do { pending = this.pending; await pending; } while (pending !== this.pending);
  }

  destroy(): void {
    this.closed = true;
    this.records.unobserve(this.receive);
    this.doc.off("update", this.publish);
  }
}
