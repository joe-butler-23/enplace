export type ImageResource = {
  url: string;
  width: number;
  height: number;
};

export type ImageResourceState =
  | { status: "ready"; resource: ImageResource }
  | { status: "error"; message: string };

export type ImageResourceKey = {
  sourcePath: string;
  resolvedPath: string;
  version: string;
  variant: "full" | "card" | "detail";
};

export function createImageResourceKey(
  sourcePath: string,
  resolvedPath: string,
  version: string,
  variant: ImageResourceKey["variant"] = "full"
): ImageResourceKey {
  return { sourcePath, resolvedPath, version, variant };
}

type ImageResourceRecord = {
  key: ImageResourceKey;
  state?: ImageResourceState;
  resource?: ImageResource;
  promise?: Promise<ImageResource | null>;
  retainUntil: number;
};

export type ImageResourceLoadRequest = {
  key: ImageResourceKey;
  loader: () => Promise<ImageResource | null>;
  priority?: number;
};

function keyFor(value: ImageResourceKey): string {
  return [value.variant, value.sourcePath, value.resolvedPath, value.version].join("\u0000");
}

/** Shared, versioned image readiness boundary for cards, recipe reads, and prewarming. */
export class ImageResourceStore {
  private readonly records = new Map<string, ImageResourceRecord>();
  private readonly listeners = new Set<() => void>();
  private readonly concurrency: number;
  private activeLoads = 0;
  private pendingLoads: Array<ImageResourceLoadRequest & { sequence: number }> = [];
  private scheduledKeys = new Set<string>();
  private sequence = 0;
  private version = 0;
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;
  private notifyScheduled = false;

  constructor(
    private readonly maxEntries = 360,
    private readonly dispose?: (resource: ImageResource) => void,
    concurrency = 3,
    private readonly retainMs = 1500
  ) {
    this.concurrency = Math.max(1, concurrency);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): number {
    return this.version;
  }

  getState(key: ImageResourceKey): ImageResourceState | undefined {
    return this.records.get(keyFor(key))?.state;
  }

  get(key: ImageResourceKey): ImageResource | undefined {
    const recordKey = keyFor(key);
    const record = this.records.get(recordKey);
    if (!record?.resource) return undefined;
    this.records.delete(recordKey);
    this.records.set(recordKey, record);
    return record.resource;
  }

  load(
    key: ImageResourceKey,
    loader: () => Promise<ImageResource | null>
  ): Promise<ImageResource | null> {
    const recordKey = keyFor(key);
    const existing = this.records.get(recordKey);
    if (existing?.resource) {
      this.records.delete(recordKey);
      this.records.set(recordKey, existing);
      return Promise.resolve(existing.resource);
    }
    if (existing?.promise) return existing.promise;
    if (existing?.state?.status === "error") return Promise.resolve(null);

    const record = existing ?? { key, retainUntil: 0 };
    const promise = loader()
      .then((resource) => {
        if (this.records.get(recordKey) !== record) return resource;
        record.promise = undefined;
        if (resource) {
          record.state = Object.freeze({ status: "ready", resource });
          record.resource = resource;
          this.records.delete(recordKey);
          this.records.set(recordKey, record);
          this.trim();
        } else {
          record.state = Object.freeze({ status: "error", message: "Cover unavailable" });
          this.records.set(recordKey, record);
        }
        this.publish();
        return resource;
      })
      .catch((error) => {
        if (this.records.get(recordKey) === record) {
          record.promise = undefined;
          record.state = Object.freeze({ status: "error", message: "Cover unavailable" });
          this.records.set(recordKey, record);
          this.publish();
        }
        throw error;
      });
    record.promise = promise;
    this.records.set(recordKey, record);
    return promise;
  }

  /** Queue requests by explicit priority: visible first, then overscan/windows. */
  schedule(requests: readonly ImageResourceLoadRequest[]): void {
    const now = Date.now();
    const queued = new Set<string>();
    const nextScheduledKeys = new Set(requests.map((request) => keyFor(request.key)));
    for (const previousKey of this.scheduledKeys) {
      if (nextScheduledKeys.has(previousKey)) continue;
      const previous = this.records.get(previousKey);
      if (previous) previous.retainUntil = Math.min(previous.retainUntil, now + this.retainMs);
    }
    this.scheduledKeys = nextScheduledKeys;
    this.pendingLoads = this.pendingLoads.filter((request) => nextScheduledKeys.has(keyFor(request.key)));
    for (const request of requests) {
      const recordKey = keyFor(request.key);
      const record = this.records.get(recordKey) ?? { key: request.key, retainUntil: 0 };
      record.retainUntil = Number.POSITIVE_INFINITY;
      this.records.set(recordKey, record);
      if (record.resource || record.promise || record.state?.status === "error" || queued.has(recordKey)) continue;
      queued.add(recordKey);
      this.pendingLoads.push({ ...request, sequence: this.sequence++ });
    }
    this.pendingLoads.sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0) || left.sequence - right.sequence);
    this.pump();
    this.scheduleTrim();
  }

  retain(key: ImageResourceKey, durationMs = this.retainMs): void {
    const recordKey = keyFor(key);
    const record = this.records.get(recordKey) ?? { key, retainUntil: 0 };
    record.retainUntil = Math.max(record.retainUntil, Date.now() + durationMs);
    this.records.set(recordKey, record);
  }

  release(key: ImageResourceKey): void {
    const record = this.records.get(keyFor(key));
    if (record) record.retainUntil = Math.min(record.retainUntil, Date.now() + this.retainMs);
    this.scheduleTrim();
  }

  invalidatePath(path: string): void {
    for (const [recordKey, record] of this.records) {
      if (record.key.sourcePath === path || record.key.resolvedPath === path) {
        if (record.resource) this.dispose?.(record.resource);
        this.records.delete(recordKey);
      }
    }
    this.publish();
  }

  clear(): void {
    for (const record of this.records.values()) {
      if (record.resource) this.dispose?.(record.resource);
    }
    this.records.clear();
    this.pendingLoads = [];
    this.scheduledKeys.clear();
    if (this.releaseTimer !== undefined) clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
    this.publish();
  }

  private trim(): void {
    const now = Date.now();
    for (const [recordKey, record] of this.records) {
      if (this.records.size <= this.maxEntries) break;
      if (record.retainUntil > now || record.promise) continue;
      if (record.resource) this.dispose?.(record.resource);
      this.records.delete(recordKey);
    }
  }

  private pump(): void {
    while (this.activeLoads < this.concurrency && this.pendingLoads.length > 0) {
      const request = this.pendingLoads.shift();
      if (!request) return;
      const record = this.records.get(keyFor(request.key));
      if (record?.resource || record?.promise || record?.state?.status === "error") continue;
      this.activeLoads += 1;
      void this.load(request.key, request.loader)
        .catch(() => null)
        .finally(() => {
          this.activeLoads = Math.max(0, this.activeLoads - 1);
          this.pump();
        });
    }
  }

  private scheduleTrim(): void {
    if (this.releaseTimer !== undefined) return;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = undefined;
      this.trim();
      if (this.records.size > this.maxEntries) this.scheduleTrim();
    }, this.retainMs);
  }

  /** Version bumps synchronously so getSnapshot() is always current; listener
   * notification is coalesced onto the microtask queue so many per-image
   * completions in the same tick (a common decode-storm pattern) collapse
   * into a single React re-render instead of one per image. */
  private publish(): void {
    this.version += 1;
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const listener of this.listeners) listener();
    });
  }
}
