import { LedgerEntry, LedgerStatus } from "./LedgerStore";

export type LedgerCounts = Record<LedgerStatus, number>;

export type HealthSnapshot = {
  lastProcessedAt: string | null;
  recentEntries: LedgerEntry[];
  ledgerCounts: LedgerCounts;
};

export class HealthService {
  constructor(private readonly getLedgerEntries: () => LedgerEntry[]) {}

  getSnapshot({ maxEntries = 20 }: { maxEntries?: number } = {}): HealthSnapshot {
    const ledgerEntries = [...this.getLedgerEntries()].sort((a, b) =>
      b.processedAt.localeCompare(a.processedAt)
    );
    const recentEntries = ledgerEntries.slice(0, maxEntries);
    const ledgerCounts: LedgerCounts = { success: 0, error: 0, skipped: 0 };
    for (const entry of ledgerEntries) ledgerCounts[entry.status] += 1;
    return {
      lastProcessedAt: recentEntries[0]?.processedAt ?? null,
      recentEntries,
      ledgerCounts
    };
  }
}
