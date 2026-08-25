import { describe, expect, it, vi } from "vitest";
import {
  advanceVaultWatchGeneration,
  applyVaultWatchBatchEntries,
  hasVaultWatchGenerationGap,
  reconcileThenRestartVaultWatcher,
  startAndReconcileVaultWatcher,
  vaultWatchAction
} from "./vault-watch-state";

describe("vault watcher generation state", () => {
  it("advances monotonically and detects only missing generations", () => {
    expect(advanceVaultWatchGeneration(7, 6)).toBe(7);
    expect(advanceVaultWatchGeneration(7, 8)).toBe(8);
    expect(hasVaultWatchGenerationGap(7, 8)).toBe(false);
    expect(hasVaultWatchGenerationGap(7, 9)).toBe(true);
  });

  it("reconciles explicit gaps and recovers explicit watcher failure", () => {
    expect(vaultWatchAction(7, { generation: 7, alive: true, changed: false })).toBe("none");
    expect(vaultWatchAction(7, { generation: 8, alive: true, changed: true })).toBe("reconcile");
    expect(vaultWatchAction(7, { generation: 7, alive: false, changed: false })).toBe("recover");
  });

  it("restarts a dead watcher only after source-truth reconciliation succeeds", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);

    await expect(
      reconcileThenRestartVaultWatcher(
        () => Promise.reject(new Error("refresh failed")),
        restart
      )
    ).rejects.toThrow("refresh failed");
    expect(restart).not.toHaveBeenCalled();

    const order: string[] = [];
    await reconcileThenRestartVaultWatcher(
      async () => { order.push("reconcile"); },
      async () => { order.push("restart"); }
    );
    expect(order).toEqual(["reconcile", "restart"]);
  });

  it("preserves the initial cursor without forcing reconciliation", async () => {
    const order: string[] = [];
    const start = vi.fn(async (generation: number) => {
      order.push(`start:${generation}`);
      return { generation, alive: true, changed: false };
    });

    await expect(
      startAndReconcileVaultWatcher(
        7,
        false,
        start,
        async () => { order.push("reconcile"); }
      )
    ).resolves.toBe(7);

    expect(order).toEqual(["start:7"]);
  });

  it("reconciles a changed cursor because watcher status does not replay paths", async () => {
    const order: string[] = [];

    await expect(
      startAndReconcileVaultWatcher(
        7,
        false,
        async (generation) => {
          order.push(`start:${generation}`);
          return { generation: 42, alive: true, changed: true };
        },
        async () => { order.push("reconcile"); }
      )
    ).resolves.toBe(42);

    expect(order).toEqual(["start:7", "reconcile"]);
  });

  it("forces source reconciliation after a replacement even without a generation change", async () => {
    const order: string[] = [];

    await expect(
      startAndReconcileVaultWatcher(
        7,
        true,
        async (generation) => {
          order.push(`start:${generation}`);
          return { generation, alive: true, changed: false };
        },
        async () => { order.push("reconcile"); }
      )
    ).resolves.toBe(7);

    expect(order).toEqual(["start:7", "reconcile"]);
  });

  it("does not force a second full refresh after recovery already reconciled", async () => {
    const order: string[] = [];

    await reconcileThenRestartVaultWatcher(
      async () => { order.push("reconcile-before-restart"); },
      async () => {
        await startAndReconcileVaultWatcher(
          7,
          false,
          async (generation) => {
            order.push(`start:${generation}`);
            return { generation, alive: true, changed: false };
          },
          async () => { order.push("reconcile-after-restart"); }
        );
      }
    );

    expect(order).toEqual(["reconcile-before-restart", "start:7"]);
  });

  it("reconciles all source truth when an early mixed-batch entry fails", async () => {
    const entries = [
      { path: "recipes/soup.md", kind: "recipe" },
      { path: "recipes/soup.jpg", kind: "cover" }
    ];
    const apply = vi.fn(async (entry: (typeof entries)[number]) => entry.kind === "cover");
    const afterApply = vi.fn(async () => {});
    const reconcile = vi.fn(async () => {});

    await expect(
      applyVaultWatchBatchEntries(
        entries,
        () => true,
        apply,
        afterApply,
        reconcile
      )
    ).resolves.toBe(true);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(afterApply).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
