import * as React from "react";
import { LedgerEntry } from "../../services/LedgerStore";
import { HealthSnapshot } from "../../services/HealthService";

interface CookingHealthProps {
  snapshot: HealthSnapshot;
  onRefresh: () => void;
  onClear: () => void;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function LedgerList({ entries, emptyMessage }: { entries: LedgerEntry[]; emptyMessage: string }): React.JSX.Element {
  if (entries.length === 0) {
    return <div className="cooking-health__empty">{emptyMessage}</div>;
  }
  return (
    <div className="cooking-health__ledger-list">
      {entries.map((entry) => (
        <div
          key={entry.key}
          className={`cooking-health__ledger-row cooking-health__ledger-row--${entry.status}`}
        >
          <div className="cooking-health__ledger-status">{entry.status}</div>
          <div className="cooking-health__ledger-detail">
            {entry.detail ?? entry.key}
          </div>
          <div className="cooking-health__ledger-time">
            {formatTimestamp(entry.processedAt)}
          </div>
        </div>
      ))}
    </div>
  );
}

export const CookingHealth = React.memo(function CookingHealth({
  snapshot,
  onRefresh,
  onClear
}: CookingHealthProps): React.JSX.Element {
  const handleClear = () => {
    if (confirm("Are you sure you want to clear the activity log?")) {
      onClear();
    }
  };

  return (
    <div className="cooking-health">
      <div className="cooking-health__header">
        <h2>Cooking Health</h2>
        <div className="cooking-health__controls">
          <button type="button" onClick={onRefresh}>Refresh</button>
          <button type="button" className="mod-warning" onClick={handleClear}>
            Clear log
          </button>
        </div>
      </div>

      <div className="cooking-health__summary">
        <div className="cooking-health__metric">
          <div className="cooking-health__metric-label">Last processed</div>
          <div className="cooking-health__metric-value">
            {formatTimestamp(snapshot.lastProcessedAt)}
          </div>
        </div>
      </div>

      <div className="cooking-health__ledger-summary">
        Ledger: {snapshot.ledgerCounts.success} success, {snapshot.ledgerCounts.error} error,{" "}
        {snapshot.ledgerCounts.skipped} skipped
      </div>

      <div className="cooking-health__ledger">
        <h3>Recent activity</h3>
        <LedgerList entries={snapshot.recentEntries} emptyMessage="No recent activity." />
      </div>
    </div>
  );
});
