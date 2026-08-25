import type { VaultWatchStatus } from "@/host-client/commands";

export type VaultWatchAction = "none" | "reconcile" | "recover";

export function advanceVaultWatchGeneration(current: number, observed: number): number {
  return Math.max(current, observed);
}

export function hasVaultWatchGenerationGap(current: number, observed: number): boolean {
  return observed > current + 1;
}

export function vaultWatchAction(
  current: number,
  status: VaultWatchStatus
): VaultWatchAction {
  if (!status.alive) return "recover";
  return status.changed || status.generation > current ? "reconcile" : "none";
}

export async function reconcileThenRestartVaultWatcher(
  reconcile: () => Promise<unknown>,
  restart: () => Promise<unknown>
): Promise<void> {
  await reconcile();
  await restart();
}

export async function startAndReconcileVaultWatcher(
  currentGeneration: number,
  replacement: boolean,
  start: (generation: number) => Promise<VaultWatchStatus>,
  reconcileChangedSource: () => Promise<unknown>
): Promise<number> {
  const status = await start(currentGeneration);
  if (!status.alive) {
    throw new Error("Vault watcher did not establish a live connection");
  }
  if (replacement || status.changed) await reconcileChangedSource();
  return advanceVaultWatchGeneration(currentGeneration, status.generation);
}

export async function applyVaultWatchBatchEntries<T>(
  entries: T[],
  shouldApply: (entry: T) => boolean,
  apply: (entry: T) => Promise<boolean>,
  afterApply: (entry: T) => Promise<void>,
  reconcileFallback: (error?: unknown) => Promise<void>
): Promise<boolean> {
  let fallback = false;
  let failure: unknown;
  for (const entry of entries) {
    if (!shouldApply(entry)) continue;
    try {
      if (!(await apply(entry))) {
        fallback = true;
        break;
      }
      await afterApply(entry);
    } catch (error) {
      fallback = true;
      failure = error;
      break;
    }
  }
  if (!fallback) return false;
  await reconcileFallback(failure);
  return true;
}
