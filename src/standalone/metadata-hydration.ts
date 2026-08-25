export type PlannerMetadataStatus =
  | { status: "waiting" }
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string }
  | { status: "cancelled" };

type MetadataHydrator = (signal: AbortSignal) => Promise<void>;

type MetadataIndex = {
  hydrateMetadata: (signal?: AbortSignal) => Promise<void>;
};

export function createIndexedMetadataHydrator(
  initialIndex: MetadataIndex,
  reindex: () => Promise<MetadataIndex>
): MetadataHydrator {
  let nextIndex: MetadataIndex | null = initialIndex;
  return async (signal) => {
    const currentIndex = nextIndex ?? await reindex();
    nextIndex = null;
    await currentIndex.hydrateMetadata(signal);
  };
}

type Listener = () => void;

type DatabaseQueryGeneration = {
  queryKey: string;
  items: readonly unknown[] | null;
  released: boolean;
};

/** Owns the exact database query/items generation allowed to release deferred metadata work. */
export class DatabaseMetadataHydrationGate {
  private current: DatabaseQueryGeneration | null = null;

  begin(queryKey: string): DatabaseQueryGeneration {
    const generation = { queryKey, items: null, released: false };
    this.current = generation;
    return generation;
  }

  invalidate(): void {
    this.current = null;
  }

  completeSource(
    generation: DatabaseQueryGeneration,
    items: readonly unknown[]
  ): boolean {
    if (this.current !== generation) return false;
    generation.items = items;
    return items.length === 0 && this.release(generation);
  }

  failSource(generation: DatabaseQueryGeneration): boolean {
    return this.release(generation);
  }

  isAwaitingFirstTranche(queryKey: string, items: readonly unknown[]): boolean {
    return this.owns(queryKey, items) && !this.current!.released;
  }

  completeFirstTrancheScheduling(queryKey: string, items: readonly unknown[]): boolean {
    return this.releaseOwned(queryKey, items);
  }

  failFirstTrancheScheduling(queryKey: string, items: readonly unknown[]): boolean {
    return this.releaseOwned(queryKey, items);
  }

  private releaseOwned(queryKey: string, items: readonly unknown[]): boolean {
    return this.owns(queryKey, items) && this.release(this.current!);
  }

  private release(generation: DatabaseQueryGeneration): boolean {
    if (this.current !== generation || generation.released) return false;
    generation.released = true;
    return true;
  }

  private owns(queryKey: string, items: readonly unknown[]): boolean {
    return this.current?.queryKey === queryKey && this.current.items === items;
  }
}

export function isCurrentDatabaseCoverSettlement(
  currentItems: readonly unknown[],
  settlement: { items: readonly unknown[]; settled: boolean } | null
): boolean {
  return settlement?.items === currentItems && settlement.settled;
}

function cancellationReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Metadata hydration was cancelled.", "AbortError");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return typeof error === "string" && error.trim() ? error : "Unknown metadata hydration error.";
}

/** Completion-owned readiness for the Planner's authoritative metadata input. */
export class PlannerMetadataHydration {
  private snapshot: PlannerMetadataStatus;
  private completion: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly hydrate: MetadataHydrator, initiallyReady = false) {
    this.snapshot = initiallyReady ? { status: "ready" } : { status: "waiting" };
  }

  getSnapshot = (): PlannerMetadataStatus => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): Promise<void> {
    if (this.snapshot.status === "ready") return Promise.resolve();
    if (this.snapshot.status === "cancelled") {
      return Promise.reject(
        new DOMException("Metadata hydration was cancelled.", "AbortError")
      );
    }
    if (this.completion) return this.completion;

    const controller = new AbortController();
    const generation = ++this.generation;
    this.controller = controller;
    this.publish({ status: "loading" });

    const completion = Promise.resolve()
      .then(() => this.hydrate(controller.signal))
      .then(() => {
        if (controller.signal.aborted || generation !== this.generation) {
          throw cancellationReason(controller.signal);
        }
        this.publish({ status: "ready" });
      })
      .catch((error: unknown) => {
        if (generation === this.generation) {
          if (controller.signal.aborted) {
            this.publish({ status: "cancelled" });
          } else {
            this.publish({ status: "error", message: errorMessage(error) });
          }
        }
        throw error;
      })
      .finally(() => {
        if (generation === this.generation && this.completion === completion) {
          this.completion = null;
          this.controller = null;
        }
      });
    this.completion = completion;
    return completion;
  }

  completeFromAuthoritativeHydration(): void {
    if (this.snapshot.status === "ready") return;
    this.generation += 1;
    this.controller?.abort(
      new DOMException("Metadata hydration was superseded by authoritative vault hydration.", "AbortError")
    );
    this.controller = null;
    this.completion = null;
    this.publish({ status: "ready" });
  }

  cancel(): void {
    if (this.snapshot.status === "cancelled") return;
    this.generation += 1;
    this.controller?.abort(
      new DOMException("Metadata hydration was cancelled.", "AbortError")
    );
    this.controller = null;
    this.completion = null;
    this.publish({ status: "cancelled" });
  }

  private publish(snapshot: PlannerMetadataStatus): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
