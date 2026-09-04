import * as React from "react";
import type { Plan, Recipe, RecipePlanning } from "@/core";
import { createWeeklyOrganiserConfig } from "../boards/weeklyOrganiserConfig";
import { buildBoardEntries, type BoardEntry } from "../kanban/buildBoardsData";
import type { OrganiserItem } from "../types";
import { resolveFilePathFromItemId } from "../utils/item-id";
import type { PlannerOrderStore } from "../utils/planner-order";
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
  onUnmarkRecipe,
  plannerOrderStore,
}: WeeklyOrganiserBoardProps): React.JSX.Element {
  const toolbar = useWeeklyToolbarState();
  const config = React.useMemo(
    () => createWeeklyOrganiserConfig(toolbar.weekOffset, dayNotes),
    [toolbar.weekOffset, dayNotes],
  );
  const layout = useWeeklyBoardLayout();
  const resolveKanbanImageSrc = React.useCallback(
    (item: OrganiserItem) => resolveCover(item.coverImage ?? null, item.path) ?? "",
    [resolveCover],
  );
  const resolveEntryCover = React.useCallback(
    (entry: BoardEntry<OrganiserItem>) => resolveKanbanImageSrc(entry.item),
    [resolveKanbanImageSrc],
  );

  const plannerEntries = usePlannerEntries({ recipes, plan, config, plannerOrderStore });
  const planner = usePlannerInteractions({
    recipes,
    config,
    updatePlanning,
    notify,
    onOpenFile,
    onUnmarkRecipe,
    plannerOrderStore,
    renderedEntriesByColumn: plannerEntries.renderedEntriesByColumn,
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
      />
      <div
        className="weekly-organiser-kanban"
        role="region"
        aria-label="Weekly organiser board"
        ref={layout.kanbanRef}
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
      </div>
    </div>
  );
});
