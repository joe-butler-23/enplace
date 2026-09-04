import * as React from "react";
import type { Plan, Recipe, RecipePlanning } from "@/core";
import {
  appendCookLogEntryToFile,
  type CookLogEntryInput,
} from "../../cooking/services/RecipeLogService";
import { buildBoardEntries } from "../kanban/buildBoardsData";
import type { OrganiserItem } from "../types";
import type { BoardConfig } from "../types/kanban-config";
import { normalizeFrontmatterDate } from "../utils/scheduled-dates";

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


type WeeklyReviewOptions = {
  recipes: readonly Recipe[];
  plan: Plan;
  config: BoardConfig;
  resolveCover: (item: OrganiserItem) => string;
  updatePlanning: (path: string, update: (planning: RecipePlanning) => RecipePlanning) => Promise<void>;
  notify: (message: string) => void;
  weekRangeDisplay: string;
  advanceWeek: () => void;
};

type WeeklyReviewState = {
  isOpen: boolean;
  isSaving: boolean;
  entries: ReviewEntry[];
  panelRef: React.RefObject<HTMLDivElement | null>;
  toggle: () => void;
  close: () => void;
  complete: () => Promise<void>;
  updateEntry: (path: string, updates: Partial<ReviewEntry>) => void;
};

function reviewEntriesForWeek(
  options: Pick<WeeklyReviewOptions, "recipes" | "plan" | "config" | "resolveCover">,
): ReviewEntry[] {
  const { entriesByFile } = buildBoardEntries(options.recipes, options.plan, options.config);
  return Array.from(entriesByFile.values())
    .filter((entry) => entry.item.date)
    .sort((a, b) => (a.item.date ?? "").localeCompare(b.item.date ?? ""))
    .map((entry) => ({
      path: entry.filePath,
      title: entry.item.title,
      scheduledDate: entry.item.date ?? "",
      cookedDate: normalizeFrontmatterDate(entry.item.date, { onInvalid: "" }) ?? "",
      coverUrl: options.resolveCover(entry.item),
      rating: "",
      makeAgain: "",
      notes: "",
      include: true,
    }));
}

function runInSequence<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
  return items.reduce((chain, item) => chain.then(() => task(item)), Promise.resolve());
}

async function saveCookLogs(entries: readonly ReviewEntry[], recipes: readonly Recipe[]): Promise<number> {
  let loggedCount = 0;
  await runInSequence(entries, async (entry) => {
    if (!entry.include) return;
    const cookedDate = entry.cookedDate.trim();
    if (!cookedDate || !recipes.some((recipe) => recipe.path === entry.path)) return;
    const ratingValue = entry.rating ? Number(entry.rating) : null;
    const rating = ratingValue !== null && Number.isNaN(ratingValue) ? null : ratingValue;
    const logEntry: CookLogEntryInput = {
      cookedDate,
      rating,
      makeAgain: entry.makeAgain === "" ? null : entry.makeAgain === "yes",
      notes: entry.notes,
    };
    try {
      await appendCookLogEntryToFile(entry.path, logEntry);
      loggedCount += 1;
    } catch (error) {
      console.error("Failed to append cook log", { path: entry.path, error });
    }
  });
  return loggedCount;
}

async function clearScheduledRecipes(
  entries: readonly ReviewEntry[],
  recipes: readonly Recipe[],
  updatePlanning: WeeklyReviewOptions["updatePlanning"],
): Promise<number> {
  let clearedCount = 0;
  await runInSequence(entries, async (entry) => {
    if (!recipes.some((recipe) => recipe.path === entry.path)) return;
    try {
      await updatePlanning(entry.path, (current) => ({ ...current, scheduledDates: [] }));
      clearedCount += 1;
    } catch (error) {
      console.error("Failed to clear scheduled date", { path: entry.path, error });
    }
  });
  return clearedCount;
}

/** Owns weekly-review draft state and its ordered cook-log and plan writes. */
export function useWeeklyReview(options: WeeklyReviewOptions): WeeklyReviewState {
  const [isOpen, setIsOpen] = React.useState(false);
  const [entries, setEntries] = React.useState<ReviewEntry[]>([]);
  const [isSaving, setIsSaving] = React.useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!isOpen) return;
    setEntries(reviewEntriesForWeek(options));
  }, [isOpen, options.config, options.plan, options.recipes, options.resolveCover]);

  const updateEntry = React.useCallback((path: string, updates: Partial<ReviewEntry>) => {
    setEntries((current) => current.map((entry) => entry.path === path ? { ...entry, ...updates } : entry));
  }, []);
  const toggle = React.useCallback(() => setIsOpen((open) => !open), []);
  const close = React.useCallback(() => setIsOpen(false), []);

  const complete = React.useCallback(async () => {
    if (isSaving) return;
    if (entries.length === 0) {
      options.notify("No scheduled recipes found for this week.");
      return;
    }
    const logCount = entries.filter((entry) => entry.include && entry.cookedDate.trim().length > 0).length;
    const message = logCount > 0
      ? `Save ${logCount} review${logCount === 1 ? "" : "s"} and clear scheduled recipes for ${
        options.weekRangeDisplay
      }?`
      : `Clear scheduled recipes for ${options.weekRangeDisplay}?`;
    if (!confirm(message)) return;

    setIsSaving(true);
    try {
      const loggedCount = await saveCookLogs(entries, options.recipes);
      const clearedCount = await clearScheduledRecipes(entries, options.recipes, options.updatePlanning);
      options.notify(`Logged ${loggedCount} recipe${loggedCount === 1 ? "" : "s"}, cleared ${clearedCount}.`);
      setIsOpen(false);
      options.advanceWeek();
    } catch (error) {
      console.error("Weekly review failed", error);
      options.notify("Weekly review failed. Check console for details.");
    } finally {
      setIsSaving(false);
    }
  }, [entries, isSaving, options]);

  return { isOpen, isSaving, entries, panelRef, toggle, close, complete, updateEntry };
}
