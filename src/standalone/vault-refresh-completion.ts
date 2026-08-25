export type VaultRefreshOutcome = "success" | "failure";

/** Emits refresh evidence only for the initialize generation that still owns it. */
export function markVaultRefreshOutcome(
  status: VaultRefreshOutcome,
  generation: number,
  currentGeneration: number
): void {
  if (generation !== currentGeneration) return;
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;

  performance.mark(
    status === "success" ? "mep:vault:refresh-complete" : "mep:vault:refresh-failed",
    { detail: { status, generation } }
  );
}
