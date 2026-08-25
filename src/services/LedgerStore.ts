export type LedgerStatus = "success" | "error" | "skipped";

export interface LedgerEntry {
  key: string;
  status: LedgerStatus;
  processedAt: string;
  detail?: string;
}

export class LedgerStore {
  private entries: Map<string, LedgerEntry>;
  private pendingFlush: Promise<void> | null = null;
  private flushQueued = false;
  private retryCount = 0;
  private readonly MAX_RETRIES = 3;

  constructor(
    initialEntries: LedgerEntry[],
    private readonly persist: (entries: LedgerEntry[]) => Promise<void>,
    private readonly limit: number = 500
  ) {
    this.entries = new Map(initialEntries.map((entry) => [entry.key, entry]));
    this.prune();
  }

  hasSuccess(key: string): boolean {
    return this.entries.get(key)?.status === "success";
  }

  recordSuccess(key: string, detail?: string): void {
    this.record(key, "success", detail);
  }

  recordError(key: string, detail?: string): void {
    this.record(key, "error", detail);
  }

  recordSkipped(key: string, detail?: string): void {
    this.record(key, "skipped", detail);
  }

  clear(): void {
    this.entries.clear();
    this.flush();
  }

  serialize(): LedgerEntry[] {
    return Array.from(this.entries.values());
  }

  private record(key: string, status: LedgerStatus, detail?: string): void {
    this.entries.set(key, {
      key,
      status,
      processedAt: new Date().toISOString(),
      detail
    });
    this.flush();
  }

  private flush() {
    this.prune();
    this.flushQueued = true;

    if (this.pendingFlush) {
      return;
    }

    this.pendingFlush = this.persistLoop()
      .catch((error) => {
        console.error('[LedgerStore] Failed to persist ledger after retries', {
          error: error instanceof Error ? error.message : String(error),
          retryCount: this.retryCount,
          timestamp: new Date().toISOString()
        });
      })
      .finally(() => {
        const hasQueuedChanges = this.flushQueued;
        this.pendingFlush = null;
        this.retryCount = 0;
        if (hasQueuedChanges) {
          this.flush();
        }
      });
  }

  private async persistLoop(): Promise<void> {
    while (this.flushQueued) {
      this.flushQueued = false;
      // Each flush observes and clears the queue before the next queued pass.
      // react-doctor-disable-next-line async-await-in-loop
      await this.persistWithRetry();
    }
  }

  private async persistWithRetry(): Promise<void> {
    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        await this.persist(this.serialize());
        return;
      } catch (error) {
        this.retryCount = attempt + 1;

        if (attempt === this.MAX_RETRIES) {
          throw error;
        }

        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 5000);
        console.warn('[LedgerStore] Persist failed, retrying', {
          attempt: attempt + 1,
          maxRetries: this.MAX_RETRIES,
          backoffMs,
          error: error instanceof Error ? error.message : String(error)
        });

        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  private prune() {
    if (this.entries.size <= this.limit) return;
    const sorted = Array.from(this.entries.values()).sort((a, b) =>
      a.processedAt.localeCompare(b.processedAt)
    );
    const overflow = sorted.length - this.limit;
    for (let i = 0; i < overflow; i += 1) {
      this.entries.delete(sorted[i].key);
    }
  }
}
