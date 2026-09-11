import * as React from "react";
import type { Plan, Recipe, RecipePlanning } from "@/core";
import { createWeeklyOrganiserConfig } from "../boards/weeklyOrganiserConfig";
import { buildBoardEntries, type BoardEntry } from "../kanban/buildBoardsData";
import type { OrganiserItem } from "../types";
import { resolveFilePathFromItemId } from "../utils/item-id";
import type { PlannerOrderStore } from "../utils/planner-order";
import { selectWeeklyShoppingRecipePaths } from "../utils/weekly-shopping-selection";
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

  const editDayNote = React.useCallback((date: string) => {
    if (!onSaveDayNote) return;
    const currentNote = dayNotes?.[date] ?? "";
    const newNote = window.prompt("Enter note for this day:", currentNote);
    if (newNote !== null && newNote !== currentNote) onSaveDayNote(date, newNote.trim());
  }, [dayNotes, onSaveDayNote]);

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

  // ArrowLeft/ArrowRight on a focused card moves it to the neighbouring column.
  const handleKanbanKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const target = event.target as HTMLElement | null;
    const card = target?.closest(".card-open-btn")?.closest(".kanban-item") as HTMLElement | null | undefined;
    if (!card?.dataset.eid) return;
    const sourceColumnId = card.closest(".kanban-board")?.getAttribute("data-id");
    const sourceIndex = config.columns.findIndex((column) => column.id === sourceColumnId);
    const targetColumnId = config.columns[sourceIndex + (event.key === "ArrowLeft" ? -1 : 1)]?.id;
    if (!sourceColumnId || !targetColumnId) return;
    event.preventDefault();
    void planner.handleDrop(resolveFilePathFromItemId(card.dataset.eid), targetColumnId, { sourceColumnId })
      .catch(() => notify("Could not move recipe. Please try again."));
  }, [config.columns, notify, planner.handleDrop]);

  return (
    <div className="weekly-organiser-container">
      <OrganiserToolbar
        {...toolbar.toolbarProps}
        onSendShoppingList={onSendShoppingList ? handleSendShoppingList : undefined}
      />
      <div
        className="weekly-organiser-kanban"
        role="region"
        aria-label="Weekly organiser board"
        onKeyDownCapture={handleKanbanKeyDownCapture}
      >
        <div id="weekly-organiser-kanban" className="weekly-organiser-kanban-host">
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
                  onNote={onSaveDayNote ? editDayNote : undefined}
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
