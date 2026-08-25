import { describe, expect, it } from "vitest";
import { HealthService } from "./HealthService";
import type { LedgerEntry } from "./LedgerStore";

describe("HealthService", () => {
  it("summarizes ledger entries and respects max entries", () => {
    const ledger: LedgerEntry[] = [
      { key: "a", status: "success", processedAt: "2026-01-01T00:00:00Z" },
      { key: "b", status: "error", processedAt: "2026-01-02T00:00:00Z" },
      { key: "c", status: "skipped", processedAt: "2026-01-03T00:00:00Z" }
    ];

    const service = new HealthService(() => ledger);

    const snapshot = service.getSnapshot({ maxEntries: 2 });
    expect(snapshot.lastProcessedAt).toBe("2026-01-03T00:00:00Z");
    expect(snapshot.recentEntries).toHaveLength(2);
    expect(snapshot.recentEntries[0].key).toBe("c");
    expect(snapshot.ledgerCounts).toEqual({ success: 1, error: 1, skipped: 1 });
  });
});
