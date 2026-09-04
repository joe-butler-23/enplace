import * as React from "react";
import type { Plan, Recipe, RecipePlanning } from "@/core";
import { createWeeklyOrganiserConfig } from "../boards/weeklyOrganiserConfig";
import { buildBoardEntries, type BoardEntry } from "../kanban/buildBoardsData";
import type { OrganiserItem } from "../types";
import { resolveFilePathFromItemId } from "../utils/item-id";
import { MIN_WEEKLY_COLUMN_WIDTH_PX } from "../utils/weekly-layout";
import { comparePlannerItems, type PlannerOrderStore } from "../utils/planner-order";
import { selectWeeklyShoppingRecipePaths } from "../utils/weekly-shopping-selection";
import { useWeeklyBoardLayout } from "../hooks/useWeeklyBoardLayout";
import { OrganiserToolbar, useWeeklyToolbarState } from "./OrganiserToolbar";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PlannerCard,
  PlannerLane,
  usePlannerEntries,
  usePlannerInteractions,
} from "./WeeklyPlannerDnd";
import { WeeklyReviewPanel, useWeeklyReview } from "./WeeklyReviewPanel";

interface WeeklyOrganiserBoardProps {
  recipes: readonly Recipe[];
  plan: Plan;
  updatePlanning: (path: string, update: (planning: RecipePlanning) => RecipePlanning) => Promise<void>;
  notify: (message: string) => void;
  resolveCover: (coverPath: string | null, sourcePath: string) => string | null;
  dayNotes?: Record<string, string>;
  onSendShoppingList?: (recipePaths: string[]) => void;
  onSaveDayNote?: (date: string, note: string) => void;
  onOpenFile: (filePath: string, options: { split: boolean }) => void;
  markedWidth?: number;
  onSaveMarkedWidth?: (width: number) => void;
  onUnmarkRecipe: (path: string) => Promise<void>;
  plannerOrderStore?: PlannerOrderStore;
}

/** Weekly organiser board rendered by React with dnd-kit pointer dragging. */
export const WeeklyOrganiserBoard = React.memo(function WeeklyOrganiserBoard({
  recipes,
  plan,
  updatePlanning,
  notify,
  resolveCover,
  dayNotes,
  onSendShoppingList,
  onSaveDayNote,
  onOpenFile,
  markedWidth = 240,
  onSaveMarkedWidth,
  onUnmarkRecipe,
  plannerOrderStore,
}: WeeklyOrganiserBoardProps): React.JSX.Element {
  const toolbar = useWeeklyToolbarState();
  const config = React.useMemo(
    () => createWeeklyOrganiserConfig(toolbar.weekOffset, dayNotes),
    [toolbar.weekOffset, dayNotes],
  );
  const layout = useWeeklyBoardLayout(markedWidth, onSaveMarkedWidth);
  const resolveKanbanImageSrc = React.useCallback(
    (item: OrganiserItem) => resolveCover(item.coverImage ?? null, item.path) ?? "",
    [resolveCover],
  );
  const resolveEntryCover = React.useCallback(
    (entry: BoardEntry<OrganiserItem>) => resolveKanbanImageSrc(entry.item),
    [resolveKanbanImageSrc],
  );

  const review = useWeeklyReview({
    recipes,
    plan,
    config,
    resolveCover: resolveKanbanImageSrc,
    updatePlanning,
    notify,
    weekRangeDisplay: toolbar.weekRangeDisplay,
    advanceWeek: toolbar.advanceWeek,
  });

  const deferredSearchQuery = React.useDeferredValue(toolbar.searchQuery);
  const normalizedSearch = React.useMemo(
    () => deferredSearchQuery.trim().toLowerCase(),
    [deferredSearchQuery],
  );
  const runtimeFilter = React.useCallback((item: OrganiserItem) => {
    if (!normalizedSearch) return true;
    return item.title.toLowerCase().includes(normalizedSearch)
      || item.path.toLowerCase().includes(normalizedSearch);
  }, [normalizedSearch]);
  const runtimeSort = React.useCallback(
    (a: OrganiserItem, b: OrganiserItem) => comparePlannerItems(toolbar.sortBy, a, b),
    [toolbar.sortBy],
  );
  const plannerEntries = usePlannerEntries({
    recipes,
    plan,
    config,
    plannerOrderStore,
    runtimeFilter,
    runtimeSort,
    sortBy: toolbar.sortBy,
  });
  const planner = usePlannerInteractions({
    recipes,
    config,
    updatePlanning,
    notify,
    onOpenFile,
    onUnmarkRecipe,
    plannerOrderStore,
    renderedEntriesByColumn: plannerEntries.renderedEntriesByColumn,
    sortBy: toolbar.sortBy,
    refreshOrder: plannerEntries.refreshOrder,
  });

  const handleColumnNoteAction = React.useCallback(
    async (event: Pick<React.SyntheticEvent, "stopPropagation" | "preventDefault">, date: string) => {
      event.stopPropagation();
      event.preventDefault();
      if (!onSaveDayNote) return;
      const currentNote = dayNotes?.[date] ?? "";
      const newNote = window.prompt("Enter note for this day:", currentNote);
      if (newNote !== null && newNote !== currentNote) onSaveDayNote(date, newNote.trim());
    },
    [dayNotes, onSaveDayNote],
  );

  const handleSendShoppingList = React.useCallback(() => {
    if (!onSendShoppingList) return;
    const { entriesByFile } = buildBoardEntries(recipes, plan, config);
    const recipePaths = selectWeeklyShoppingRecipePaths(
      entriesByFile.values(),
      toolbar.startDateValue,
      toolbar.endDateValue,
    );
    onSendShoppingList(recipePaths);
  }, [config, onSendShoppingList, plan, recipes, toolbar.endDateValue, toolbar.startDateValue]);

  const handleKanbanClickCapture = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    const noteButton = target?.closest(".organiser-column-note") as HTMLElement | null;
    const date = noteButton?.dataset.date;
    if (date) void handleColumnNoteAction(event, date);
  }, [handleColumnNoteAction]);

  const handleKanbanKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest(".card-open-btn")) {
      const card = target.closest(".kanban-item") as HTMLElement | null;
      if (!card?.dataset.eid || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      const sourceColumnId = card.closest(".kanban-board")?.getAttribute("data-id");
      const sourceIndex = config.columns.findIndex((column) => column.id === sourceColumnId);
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const targetColumnId = config.columns[sourceIndex + direction]?.id;
      if (!sourceColumnId || !targetColumnId) return;
      event.preventDefault();
      void planner.handleDrop(resolveFilePathFromItemId(card.dataset.eid), targetColumnId, { sourceColumnId })
        .catch(() => notify("Could not move recipe. Please try again."));
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    const noteButton = target?.closest(".organiser-column-note") as HTMLElement | null;
    const date = noteButton?.dataset.date;
    if (!date) return;
    event.preventDefault();
    void handleColumnNoteAction(event, date);
  }, [config.columns, handleColumnNoteAction, notify, planner.handleDrop]);

  return (
    <div ref={layout.plannerRootRef} className="weekly-organiser-container">
      <OrganiserToolbar
        {...toolbar.toolbarProps}
        onSendShoppingList={onSendShoppingList ? handleSendShoppingList : undefined}
        isReviewOpen={review.isOpen}
        onToggleReview={review.toggle}
      />
      {review.isOpen && (
        <WeeklyReviewPanel
          entries={review.entries}
          isSaving={review.isSaving}
          weekRangeDisplay={toolbar.weekRangeDisplay}
          panelRef={review.panelRef}
          onClose={review.close}
          onCompleteWeek={review.complete}
          onUpdateEntry={review.updateEntry}
        />
      )}
      <div
        className="weekly-organiser-kanban"
        role="region"
        aria-label="Weekly organiser board"
        ref={layout.kanbanRef}
        style={{
          position: "relative",
          "--col-min-width": `${layout.currentMarkedWidth}px`,
        } as React.CSSProperties}
        onClickCapture={handleKanbanClickCapture}
        onKeyDownCapture={handleKanbanKeyDownCapture}
      >
        <div
          id="weekly-organiser-kanban"
          className={`weekly-organiser-kanban-host${planner.activeDrag ? " is-board-dragging" : ""}`}
        >
          <DndContext
            sensors={planner.sensors}
            collisionDetection={closestCenter}
            onDragStart={planner.handleDragStart}
            onDragEnd={planner.handleDragEnd}
            onDragCancel={planner.cancelDrag}
          >
            <div className="kanban-container">
              {config.columns.map((column) => (
                <PlannerLane
                  key={column.id}
                  column={column}
                  entries={plannerEntries.renderedEntriesByColumn.get(column.id) ?? []}
                  resolveCover={resolveEntryCover}
                  onOpen={planner.handleCardClick}
                  onRemove={(path, sourceColumnId) => {
                    void planner.handleRemoveRecipe(path, sourceColumnId).catch(() =>
                      notify("Could not remove recipe. Please try again."),
                    );
                  }}
                />
              ))}
            </div>
            <DragOverlay dropAnimation={null} style={{ pointerEvents: "none" }}>
              {planner.overlayEntry ? (
                <PlannerCard
                  entry={planner.overlayEntry}
                  coverUrl={resolveEntryCover(planner.overlayEntry)}
                  overlay
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
        <div
          className={`marked-col-resizer${layout.isResizingMarked ? " is-resizing" : ""}`}
          role="separator"
          aria-label="Resize marked column"
          aria-orientation="vertical"
          aria-valuemin={MIN_WEEKLY_COLUMN_WIDTH_PX}
          aria-valuenow={layout.currentMarkedWidth}
          aria-valuetext={`${layout.currentMarkedWidth} pixels`}
          tabIndex={0}
          onMouseDown={layout.startResize}
          onKeyDown={layout.resizeWithKeyboard}
        />
      </div>
    </div>
  );
});
