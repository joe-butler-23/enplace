import { describe, expect, it, vi } from "vitest";
import {
  createIndexedMetadataHydrator,
  DatabaseMetadataHydrationGate,
  isCurrentDatabaseCoverSettlement,
  PlannerMetadataHydration
} from "./metadata-hydration";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("PlannerMetadataHydration", () => {
  it("keeps an immediate Planner navigation loading until one shared hydration completes", async () => {
    const pending = deferred<void>();
    const hydrate = vi.fn(() => pending.promise);
    const readiness = new PlannerMetadataHydration(hydrate);

    const first = readiness.start();
    const second = readiness.start();

    expect(first).toBe(second);
    expect(hydrate).not.toHaveBeenCalled();
    expect(readiness.getSnapshot()).toEqual({ status: "loading" });

    await Promise.resolve();
    expect(hydrate).toHaveBeenCalledTimes(1);
    pending.resolve();
    await first;

    expect(readiness.getSnapshot()).toEqual({ status: "ready" });
  });

  it("keeps a failed attempt non-ready and executes a fresh retry", async () => {
    const hydrate = vi.fn()
      .mockRejectedValueOnce(new Error("batch read failed"))
      .mockResolvedValueOnce(undefined);
    const readiness = new PlannerMetadataHydration(hydrate);

    await expect(readiness.start()).rejects.toThrow("batch read failed");
    expect(readiness.getSnapshot()).toEqual({
      status: "error",
      message: "batch read failed"
    });

    await expect(readiness.start()).resolves.toBeUndefined();
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(readiness.getSnapshot()).toEqual({ status: "ready" });
  });

  it("re-indexes for retry after the original folder generation is superseded", async () => {
    const oldRead = deferred<void>();
    const initialIndex = {
      hydrateMetadata: vi.fn(async () => {
        await oldRead.promise;
        throw new Error("Folder metadata hydration was superseded by a newer vault index.");
      })
    };
    const freshIndex = { hydrateMetadata: vi.fn().mockResolvedValue(undefined) };
    const reindex = vi.fn().mockResolvedValue(freshIndex);
    const readiness = new PlannerMetadataHydration(
      createIndexedMetadataHydrator(initialIndex, reindex)
    );

    const staleAttempt = readiness.start();
    await Promise.resolve();
    oldRead.resolve();
    await expect(staleAttempt).rejects.toThrow("superseded");
    expect(readiness.getSnapshot().status).toBe("error");

    await expect(readiness.start()).resolves.toBeUndefined();
    expect(reindex).toHaveBeenCalledTimes(1);
    expect(freshIndex.hydrateMetadata).toHaveBeenCalledTimes(1);
    expect(readiness.getSnapshot()).toEqual({ status: "ready" });
  });

  it("accepts authoritative vault hydration without re-reading the indexed folder", async () => {
    const hydrate = vi.fn().mockResolvedValue(undefined);
    const readiness = new PlannerMetadataHydration(hydrate);

    readiness.completeFromAuthoritativeHydration();
    await expect(readiness.start()).resolves.toBeUndefined();

    expect(hydrate).not.toHaveBeenCalled();
    expect(readiness.getSnapshot()).toEqual({ status: "ready" });
  });

  it("fences a superseded in-flight folder hydration after authoritative completion", async () => {
    const pending = deferred<void>();
    const readiness = new PlannerMetadataHydration(() => pending.promise);
    const stale = readiness.start();
    await Promise.resolve();

    readiness.completeFromAuthoritativeHydration();
    pending.resolve();
    await expect(stale).rejects.toMatchObject({ name: "AbortError" });

    expect(readiness.getSnapshot()).toEqual({ status: "ready" });
  });

  it("cancels an in-flight generation and never publishes its late completion as ready", async () => {
    const pending = deferred<void>();
    let signal: AbortSignal | undefined;
    const readiness = new PlannerMetadataHydration((nextSignal) => {
      signal = nextSignal;
      return pending.promise;
    });

    const completion = readiness.start();
    await Promise.resolve();
    readiness.cancel();

    expect(signal?.aborted).toBe(true);
    expect(readiness.getSnapshot()).toEqual({ status: "cancelled" });
    pending.resolve();
    await expect(completion).rejects.toMatchObject({ name: "AbortError" });
    expect(readiness.getSnapshot()).toEqual({ status: "cancelled" });
  });
});


describe("database metadata scheduling gate", () => {
  it("releases after the current 500-item generation schedules only its first tranche", () => {
    const gate = new DatabaseMetadataHydrationGate();
    const items = Array.from({ length: 500 }, (_, index) => ({ index }));
    const generation = gate.begin("query-a");

    expect(gate.isAwaitingFirstTranche("query-a", items)).toBe(false);
    expect(gate.completeSource(generation, items)).toBe(false);
    expect(gate.isAwaitingFirstTranche("query-a", items)).toBe(true);

    // No all-cover settlement participates: this is owned scheduling of the first five only.
    expect(gate.completeFirstTrancheScheduling("query-a", items)).toBe(true);
    expect(gate.completeFirstTrancheScheduling("query-a", items)).toBe(false);
  });

  it("releases a rearmed same-key generation without replacing its retained 500-cover schedule", () => {
    const gate = new DatabaseMetadataHydrationGate();
    const firstItems = Array.from({ length: 500 }, (_, index) => ({ path: `recipe-${index}` }));
    const retainedScheduledKeys = new Set(firstItems.map((item) => item.path));
    const firstGeneration = gate.begin("same-query");
    expect(gate.completeSource(firstGeneration, firstItems)).toBe(false);
    expect(gate.completeFirstTrancheScheduling("same-query", firstItems)).toBe(true);

    const currentItems = firstItems.map((item) => ({ ...item }));
    const currentGeneration = gate.begin("same-query");
    expect(gate.completeSource(currentGeneration, currentItems)).toBe(false);
    expect(gate.completeFirstTrancheScheduling("same-query", currentItems)).toBe(true);

    expect(retainedScheduledKeys.size).toBe(500);
    expect([...retainedScheduledKeys]).toEqual(firstItems.map((item) => item.path));
  });

  it("rejects stale first-tranche work even when the query key recurs", () => {
    const gate = new DatabaseMetadataHydrationGate();
    const oldItems = Array.from({ length: 500 }, (_, index) => ({ index }));
    const oldGeneration = gate.begin("same-query");
    expect(gate.completeSource(oldGeneration, oldItems)).toBe(false);

    const currentItems = Array.from({ length: 500 }, (_, index) => ({ index }));
    const currentGeneration = gate.begin("same-query");
    expect(gate.completeSource(currentGeneration, currentItems)).toBe(false);

    expect(gate.completeFirstTrancheScheduling("same-query", oldItems)).toBe(false);
    expect(gate.completeFirstTrancheScheduling("same-query", currentItems)).toBe(true);
  });

  it("releases current empty, source-error, and first-tranche-error terminals", () => {
    const gate = new DatabaseMetadataHydrationGate();

    const empty = gate.begin("empty");
    expect(gate.completeSource(empty, [])).toBe(true);

    const failedSource = gate.begin("source-error");
    expect(gate.failSource(failedSource)).toBe(true);

    const items = [{ index: 0 }];
    const failedTranche = gate.begin("stage-1-error");
    expect(gate.completeSource(failedTranche, items)).toBe(false);
    expect(gate.failFirstTrancheScheduling("stage-1-error", items)).toBe(true);
  });

  it("keeps cover settlement generation-fenced for image prewarm only", () => {
    const emptyItems: unknown[] = [];
    const streamedItems = Array.from({ length: 500 }, (_, index) => ({ index }));

    expect(isCurrentDatabaseCoverSettlement(
      streamedItems,
      { items: emptyItems, settled: true }
    )).toBe(false);
    expect(isCurrentDatabaseCoverSettlement(
      streamedItems,
      { items: streamedItems, settled: true }
    )).toBe(true);
  });
});
