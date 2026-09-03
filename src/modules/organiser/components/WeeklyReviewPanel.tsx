import * as React from "react";

export type ReviewEntry = {
  path: string;
  title: string;
  scheduledDate: string;
  cookedDate: string;
  coverUrl: string;
  rating: string;
  makeAgain: "" | "yes" | "no";
  notes: string;
  include: boolean;
};

type WeeklyReviewPanelProps = {
  entries: ReviewEntry[];
  isSaving: boolean;
  weekRangeDisplay: string;
  panelRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onCompleteWeek: () => void;
  onUpdateEntry: (path: string, updates: Partial<ReviewEntry>) => void;
};

export function WeeklyReviewPanel({
  entries,
  isSaving,
  weekRangeDisplay,
  panelRef,
  onClose,
  onCompleteWeek,
  onUpdateEntry,
}: WeeklyReviewPanelProps): React.JSX.Element {
  return (
    <div className="weekly-review-panel" ref={panelRef}>
      <div className="weekly-review-header">
        <div className="weekly-review-heading">
          <div className="weekly-review-title">Weekly review</div>
          <div className="weekly-review-meta">{weekRangeDisplay}</div>
        </div>
      </div>
      <div className="weekly-review-hint">
        Log what you cooked this week. Uncheck a recipe to skip logging.
      </div>
      {entries.length === 0 ? (
        <div className="weekly-review-empty">
          No scheduled recipes for this week.
        </div>
      ) : (
        <div className="weekly-review-list">
          {entries.map((entry) => (
            <div
              key={entry.path}
              className={`weekly-review-row${entry.include ? "" : " is-disabled"}`}
            >
              <div className="weekly-review-row-header">
                <div className="weekly-review-row-info">
                  {entry.coverUrl ? (
                    <div className="weekly-review-thumb">
                      <img src={entry.coverUrl} alt="" loading="lazy" aria-hidden="true" />
                    </div>
                  ) : null}
                  <div className="weekly-review-row-title">
                    <div className="weekly-review-row-name">
                      {entry.title}
                    </div>
                    <div className="weekly-review-row-meta">
                      Planned {entry.scheduledDate}
                    </div>
                  </div>
                </div>
                <div className="weekly-review-row-controls">
                  <label className="weekly-review-inline weekly-review-inline--date">
                    <span>Date</span>
                    <input
                      type="date"
                      value={entry.cookedDate}
                      onChange={(event) =>
                        onUpdateEntry(entry.path, {
                          cookedDate: event.target.value,
                        })
                      }
                      disabled={isSaving || !entry.include}
                    />
                  </label>
                  <label className="weekly-review-inline weekly-review-inline--rating">
                    <span>Rate</span>
                    <select
                      value={entry.rating}
                      onChange={(event) =>
                        onUpdateEntry(entry.path, {
                          rating: event.target.value,
                        })
                      }
                      disabled={isSaving || !entry.include}
                    >
                      <option value="">—</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                      <option value="4">4</option>
                      <option value="5">5</option>
                    </select>
                  </label>
                  <label className="weekly-review-inline weekly-review-inline--again">
                    <span>Again</span>
                    <select
                      value={entry.makeAgain}
                      onChange={(event) =>
                        onUpdateEntry(entry.path, {
                          makeAgain: event.target.value as "" | "yes" | "no",
                        })
                      }
                      disabled={isSaving || !entry.include}
                    >
                      <option value="">—</option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  </label>
                </div>
                <label className="weekly-review-toggle">
                  <input
                    type="checkbox"
                    checked={entry.include}
                    onChange={(event) =>
                      onUpdateEntry(entry.path, {
                        include: event.target.checked,
                      })
                    }
                    disabled={isSaving}
                  />
                  <span>Cooked</span>
                </label>
              </div>
              <label className="weekly-review-field weekly-review-field--notes">
                <span>Notes</span>
                <textarea
                  rows={2}
                  value={entry.notes}
                  onChange={(event) =>
                    onUpdateEntry(entry.path, {
                      notes: event.target.value,
                    })
                  }
                  disabled={isSaving || !entry.include}
                />
              </label>
            </div>
          ))}
        </div>
      )}
      <div className="weekly-review-actions">
        <button
          type="button"
          onClick={onClose}
          disabled={isSaving}
        >
          Close
        </button>
        <button
          type="button"
          className="mod-cta"
          onClick={onCompleteWeek}
          disabled={isSaving || entries.length === 0}
        >
          {isSaving ? "Saving..." : "Save review & clear week"}
        </button>
      </div>
    </div>
  );
}
