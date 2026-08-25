import { describe, expect, it, vi } from "vitest";
import { LedgerStore } from "./LedgerStore";

describe("LedgerStore", () => {
  it("records success and prunes oldest entries", () => {
    const persisted: string[] = [];
    const store = new LedgerStore([], async (entries) => {
      persisted.push(JSON.stringify(entries));
    }, 2);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    store.recordSuccess("job-a");
    vi.setSystemTime(new Date("2026-01-01T00:00:01Z"));
    store.recordSuccess("job-b");
    vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
    store.recordSuccess("job-c");
    vi.useRealTimers();

    expect(store.hasSuccess("job-a")).toBe(false);
    expect(store.hasSuccess("job-b")).toBe(true);
    expect(store.hasSuccess("job-c")).toBe(true);
    expect(store.serialize().length).toBe(2);
    expect(persisted.length).toBeGreaterThan(0);
  });

  it("flushes writes queued during an in-flight persist", async () => {
    let resolveFirstPersist: (() => void) | null = null;
    const persisted: unknown[][] = [];
    const persist = vi
      .fn<[unknown[]], Promise<void>>()
      .mockImplementation((entries) => new Promise<void>((resolve) => {
        persisted.push(entries);
        if (!resolveFirstPersist) {
          resolveFirstPersist = resolve;
          return;
        }
        resolve();
      }));

    const store = new LedgerStore([], persist);
    store.recordSuccess("job-a");
    store.recordSuccess("job-b");

    expect(store.serialize()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "job-a", status: "success" }),
        expect.objectContaining({ key: "job-b", status: "success" })
      ])
    );

    resolveFirstPersist?.();
    await vi.waitFor(() => {
      expect(persisted.at(-1)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "job-a", status: "success" }),
          expect.objectContaining({ key: "job-b", status: "success" })
        ])
      );
    });
  });

  it("restarts flush when queued writes exist after a retry-exhausted failure", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const persisted: unknown[][] = [];
    const persist = vi.fn<[unknown[]], Promise<void>>().mockImplementation(async (entries) => {
      attempts += 1;
      if (attempts <= 4) {
        throw new Error("transient");
      }
      persisted.push(entries);
    });

    const store = new LedgerStore([], persist);
    store.recordSuccess("job-a");
    store.recordSuccess("job-b");

    await vi.runAllTimersAsync();
    await vi.waitFor(() => {
      expect(store.serialize()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "job-a", status: "success" }),
          expect.objectContaining({ key: "job-b", status: "success" })
        ])
      );
    });
    await vi.waitFor(() => {
      expect(persisted.at(-1)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "job-a", status: "success" }),
          expect.objectContaining({ key: "job-b", status: "success" })
        ])
      );
    });

    vi.useRealTimers();
  });
});
