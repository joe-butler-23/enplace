import * as React from "react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Plan, Recipe, RecipePlanning } from "@/core";
import { buildBoardEntries, type BoardEntry } from "../kanban/buildBoardsData";
import { laneClassNameFor, resolveOrganiserDrop } from "../kanban/dropPolicy";
import type { OrganiserItem } from "../types";
import type { BoardConfig, ColumnDefinition } from "../types/kanban-config";
import {
  isIsoDateString,
  removeRecipeScheduledDateOccurrence,
  type RecipeDateRemovalResult,
} from "../utils/recipe-schedule-actions";
import { removePlannerRecipe } from "../utils/planner-recipe-removal";
import { plannerOrderKey, type PlannerOrderStore } from "../utils/planner-order";

type PlannerDrag = {
  entryId: string;
  filePath: string;
  sourceColumnId: string;
  duplicate: boolean;
};

type PlannerCardProps = {
  entry: BoardEntry<OrganiserItem>;
  coverUrl: string;
  overlay?: boolean;
  onOpen?: (event: React.MouseEvent, path: string) => void;
  onRemove?: (path: string, sourceColumnId: string) => void;
};

const RECIPE_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" />
    <path d="M7 2v20" />
    <path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />
  </svg>
);

export function PlannerCard({
  entry,
  coverUrl,
  overlay = false,
  onOpen,
  onRemove,
}: PlannerCardProps): React.JSX.Element {
  const sortable = useSortable({
    id: overlay ? `overlay:${entry.entryId}` : entry.entryId,
    data: { type: "card", laneId: entry.columnId, entry },
    disabled: overlay,
  });
  const handleProps = overlay ? {} : { ...sortable.attributes, ...sortable.listeners };
  const transform = sortable.isDragging ? undefined : CSS.Transform.toString(sortable.transform);
  return (
    <div
      ref={overlay ? undefined : sortable.setNodeRef}
      className={`kanban-item organiser-card--recipe-card${overlay ? " is-drag-overlay" : ""}${sortable.isDragging ? " is-dragging" : ""}`}
      data-eid={entry.entryId}
      style={{ transform, visibility: sortable.isDragging ? "hidden" : undefined }}
    >
      <div className="organiser-card-content">
        <button
          className="card-remove-btn"
          title="Unschedule recipe"
          aria-label="Unschedule recipe"
          onClick={(event) => {
            event.stopPropagation();
            onRemove?.(entry.filePath, entry.columnId);
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        {coverUrl ? (
          <div
            className="card-cover"
            {...handleProps}
            style={{ touchAction: "none" }}
            onClick={(event) => onOpen?.(event, entry.filePath)}
          >
            <img src={coverUrl} alt={entry.item.title} decoding="async" draggable={false} />
          </div>
        ) : null}
        <button
          type="button"
          className="card-open-btn card-header"
          aria-label={`Open ${entry.item.title}`}
          {...(!coverUrl ? handleProps : {})}
          style={!coverUrl ? { touchAction: "none" } : undefined}
          onClick={(event) => onOpen?.(event, entry.filePath)}
        >
          {RECIPE_ICON}
          <span className="card-title">{entry.item.title}</span>
        </button>
      </div>
    </div>
  );
}

type PlannerLaneProps = {
  column: ColumnDefinition;
  entries: BoardEntry<OrganiserItem>[];
  resolveCover: (entry: BoardEntry<OrganiserItem>) => string;
  onOpen: (event: React.MouseEvent, path: string) => void;
  onRemove: (path: string, sourceColumnId: string) => void;
};

export function PlannerLane({ column, entries, resolveCover, onOpen, onRemove }: PlannerLaneProps): React.JSX.Element {
  const { setNodeRef } = useDroppable({ id: column.id, data: { type: "lane", laneId: column.id } });
  const densityClass = column.id !== "marked" && entries.length > 1 ? " kanban-board--multi-recipe" : "";
  const headerClass = laneClassNameFor(column.id);
  return (
    <div
      ref={setNodeRef}
      className={`kanban-board${densityClass}`}
      data-id={column.id}
      style={{
        width: "100%",
        marginLeft: "0px",
        marginRight: "0px",
        gridRow: column.gridRow,
        gridColumn: column.gridColumn,
      }}
    >
      <header className={`kanban-board-header${headerClass ? ` ${headerClass}` : ""}`}>
        <div className="kanban-title-board" dangerouslySetInnerHTML={{ __html: column.title }} />
      </header>
      <SortableContext items={entries.map((entry) => entry.entryId)} strategy={verticalListSortingStrategy}>
        <div className="kanban-drag">
          {entries.map((entry) => (
            <PlannerCard
              key={entry.filePath}
              entry={entry}
              coverUrl={resolveCover(entry)}
              onOpen={onOpen}
              onRemove={onRemove}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}

type PlannerEntriesOptions = {
  recipes: readonly Recipe[];
  plan: Plan;
  config: BoardConfig;
  plannerOrderStore?: PlannerOrderStore;
  runtimeFilter: (item: OrganiserItem) => boolean;
  runtimeSort: (a: OrganiserItem, b: OrganiserItem) => number;
  sortBy: string;
};

type UsePlannerInteractionsOptions = {
  recipes: readonly Recipe[];
  config: BoardConfig;
  updatePlanning: (path: string, update: (planning: RecipePlanning) => RecipePlanning) => Promise<void>;
  notify: (message: string) => void;
  onOpenFile: (filePath: string, options: { split: boolean }) => void;
  onUnmarkRecipe: (path: string) => Promise<void>;
  plannerOrderStore?: PlannerOrderStore;
  renderedEntriesByColumn: Map<string, BoardEntry<OrganiserItem>[]>;
  sortBy: string;
  refreshOrder: () => void;
};

type EntryOrders = {
  sourceIds: string[];
  targetIds: string[];
  targetEntryId: string;
};

export function insertionIndexForDrop(event: DragEndEvent, targetIds: readonly string[]): number {
  if (!event.over) return targetIds.length;
  const overIndex = targetIds.indexOf(String(event.over.id));
  if (overIndex < 0) return targetIds.length;
  const translated = event.active.rect.current.translated;
  const afterOver = translated !== null
    && translated.top > event.over.rect.top + event.over.rect.height / 2;
  return Math.min(targetIds.length, overIndex + (afterOver ? 1 : 0));
}

export function entryOrdersAfterDrop(
  event: DragEndEvent,
  drag: PlannerDrag,
  targetColumnId: string,
  duplicate: boolean,
  entriesByColumn: Map<string, BoardEntry<OrganiserItem>[]>,
): EntryOrders | null {
  const sourceIds = (entriesByColumn.get(drag.sourceColumnId) ?? []).map((entry) => entry.entryId);
  const currentTargetIds = (entriesByColumn.get(targetColumnId) ?? []).map((entry) => entry.entryId);
  const targetEntryId = `${drag.filePath}::${targetColumnId}`;
  if (duplicate && currentTargetIds.includes(targetEntryId)) return null;
  const insertionIndex = insertionIndexForDrop(event, currentTargetIds);

  if (drag.sourceColumnId === targetColumnId) {
    const fromIndex = sourceIds.indexOf(drag.entryId);
    const destination = insertionIndex > fromIndex ? insertionIndex - 1 : insertionIndex;
    const toIndex = Math.max(0, Math.min(sourceIds.length - 1, destination));
    if (fromIndex < 0 || fromIndex === toIndex) return null;
    const reordered = arrayMove(sourceIds, fromIndex, toIndex);
    return { sourceIds: reordered, targetIds: reordered, targetEntryId };
  }

  const nextSourceIds = duplicate ? sourceIds : sourceIds.filter((id) => id !== drag.entryId);
  const existingTargetIndex = currentTargetIds.indexOf(targetEntryId);
  const targetWithoutEntry = currentTargetIds.filter((id) => id !== targetEntryId);
  const adjustedIndex = existingTargetIndex >= 0 && existingTargetIndex < insertionIndex
    ? insertionIndex - 1
    : insertionIndex;
  const targetIndex = Math.min(adjustedIndex, targetWithoutEntry.length);
  const targetIds = [
    ...targetWithoutEntry.slice(0, targetIndex),
    targetEntryId,
    ...targetWithoutEntry.slice(targetIndex),
  ];
  return { sourceIds: nextSourceIds, targetIds, targetEntryId };
}

async function updateScheduledDatesForDrop(
  path: string,
  targetColumnId: string,
  sourceColumnId: string | undefined,
  duplicate: boolean,
  updatePlanning: UsePlannerInteractionsOptions["updatePlanning"],
): Promise<void> {
  await updatePlanning(path, (planning) => {
    const nextDates = [...planning.scheduledDates];
    if (!duplicate && sourceColumnId && isIsoDateString(sourceColumnId) && sourceColumnId !== targetColumnId) {
      const sourceIndex = nextDates.indexOf(sourceColumnId);
      if (sourceIndex !== -1) nextDates.splice(sourceIndex, 1);
    }
    if (!nextDates.includes(targetColumnId)) nextDates.push(targetColumnId);
    return { marked: false, scheduledDates: nextDates.sort((a, b) => a.localeCompare(b)) };
  });
}

export function usePlannerEntries(options: PlannerEntriesOptions) {
  const [orderRevision, setOrderRevision] = React.useState(0);
  const renderedEntriesByColumn = React.useMemo(() => {
    const { entriesByColumn } = buildBoardEntries(options.recipes, options.plan, options.config, {
      plannerOrderStore: options.plannerOrderStore,
      plannerOrderPresetId: "weekly",
      manualOrder: options.sortBy === "default",
    });
    const rendered = new Map<string, BoardEntry<OrganiserItem>[]>();
    for (const column of options.config.columns) {
      const filtered = (entriesByColumn.get(column.id) ?? []).filter(({ item }) => options.runtimeFilter(item));
      rendered.set(column.id, [...filtered].sort((a, b) => options.runtimeSort(a.item, b.item)));
    }
    return rendered;
  }, [
    options.config,
    options.plan,
    options.plannerOrderStore,
    options.recipes,
    options.runtimeFilter,
    options.runtimeSort,
    options.sortBy,
    orderRevision,
  ]);
  const refreshOrder = React.useCallback(() => setOrderRevision((value) => value + 1), []);
  return { renderedEntriesByColumn, refreshOrder };
}

export function usePlannerInteractions(options: UsePlannerInteractionsOptions) {
  const [activeDrag, setActiveDrag] = React.useState<PlannerDrag | null>(null);
  const dropQueuesRef = React.useRef(new Map<string, Promise<void>>());
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const renderedEntriesByColumn = options.renderedEntriesByColumn;

  const handleDrop = React.useCallback(async (
    itemId: string,
    targetColumnId: string,
    dropOptions?: { sourceColumnId?: string; duplicate?: boolean },
  ) => {
    if (!options.recipes.some((recipe) => recipe.path === itemId)) return;
    const targetColumn = options.config.columns.find((column) => column.id === targetColumnId);
    if (!targetColumn) return;
    const duplicate = dropOptions?.duplicate === true && !targetColumn.isDefault;
    const sourceColumnId = dropOptions?.sourceColumnId;
    if (!duplicate && targetColumn.isDefault && isIsoDateString(sourceColumnId)) {
      const removalState: { result: RecipeDateRemovalResult | null } = { result: null };
      await options.updatePlanning(itemId, (current) => {
        const next = { ...current, scheduledDates: [...current.scheduledDates] };
        removalState.result = removeRecipeScheduledDateOccurrence(next, sourceColumnId);
        return next;
      });
      const result = removalState.result;
      console.info("planner_drop_recipe_to_marked", {
        filePath: itemId,
        sourceColumnId,
        targetColumnId,
        result,
        refreshColumns: ["marked", sourceColumnId],
      });
      if (result && !result.marked) return { deleted: true };
      return;
    }
    if (isIsoDateString(targetColumnId)) {
      await updateScheduledDatesForDrop(itemId, targetColumnId, sourceColumnId, duplicate, options.updatePlanning);
      return;
    }
    if (targetColumn.isDefault) {
      await options.updatePlanning(itemId, () => ({ marked: true, scheduledDates: [] }));
    }
  }, [options.config, options.recipes, options.updatePlanning]);

  const handleCardClick = React.useCallback((event: React.MouseEvent, itemId: string) => {
    if (!options.recipes.some((recipe) => recipe.path === itemId)) return;
    options.onOpenFile(itemId, { split: event.ctrlKey || event.metaKey });
  }, [options.onOpenFile, options.recipes]);

  const handleRemoveRecipe = React.useCallback(async (itemId: string, sourceColumnId: string) => {
    if (!options.recipes.some((recipe) => recipe.path === itemId)) return;
    await removePlannerRecipe(
      sourceColumnId,
      async (date) => {
        let result: RecipeDateRemovalResult | null = null;
        await options.updatePlanning(itemId, (current) => {
          const next = { ...current, scheduledDates: [...current.scheduledDates] };
          result = removeRecipeScheduledDateOccurrence(next, date, { markWhenEmpty: false });
          return next;
        });
        console.info("planner_remove_recipe_date_occurrence", { filePath: itemId, sourceColumnId: date, result });
      },
      () => options.onUnmarkRecipe(itemId),
    );
  }, [options.onUnmarkRecipe, options.recipes, options.updatePlanning]);

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    const entry = event.active.data.current?.entry as BoardEntry<OrganiserItem> | undefined;
    if (!entry) return;
    const activator = event.activatorEvent;
    setActiveDrag({
      entryId: entry.entryId,
      filePath: entry.filePath,
      sourceColumnId: entry.columnId,
      duplicate: "shiftKey" in activator && Boolean(activator.shiftKey),
    });
  }, []);

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const drag = activeDrag;
    setActiveDrag(null);
    if (!drag || !event.over) return;
    const targetColumnId = String(event.over.data.current?.laneId ?? event.over.id);
    if (!options.config.columns.some((column) => column.id === targetColumnId)) return;
    const outcome = resolveOrganiserDrop({
      cardId: drag.entryId,
      sourceLaneId: drag.sourceColumnId,
      targetLaneId: targetColumnId,
      isTemplate: false,
      duplicateModifier: drag.duplicate,
    });
    if (outcome === "reject" || outcome === "remove") return;
    const duplicate = outcome === "copy";
    const orders = entryOrdersAfterDrop(event, drag, targetColumnId, duplicate, renderedEntriesByColumn);
    if (!orders) return;

    const previous = dropQueuesRef.current.get(drag.filePath) ?? Promise.resolve();
    const commit = previous.catch(() => undefined).then(async () => {
      const result = drag.sourceColumnId === targetColumnId
        ? undefined
        : await handleDrop(drag.filePath, targetColumnId, { sourceColumnId: drag.sourceColumnId, duplicate });
      if (result?.deleted === true) {
        orders.targetIds = orders.targetIds.filter((id) => id !== orders.targetEntryId);
      }
      if (options.sortBy === "default" && options.plannerOrderStore) {
        const updates = new Map<string, readonly string[]>();
        updates.set(plannerOrderKey(options.config.id, "weekly", drag.sourceColumnId), orders.sourceIds);
        updates.set(plannerOrderKey(options.config.id, "weekly", targetColumnId), orders.targetIds);
        await options.plannerOrderStore.replaceMany(updates);
        options.refreshOrder();
      }
    }).catch((error) => {
      console.error("[WeeklyOrganiser] Failed to move recipe", error);
      options.notify("Could not move recipe. Please try again.");
    }).finally(() => {
      if (dropQueuesRef.current.get(drag.filePath) === commit) dropQueuesRef.current.delete(drag.filePath);
    });
    dropQueuesRef.current.set(drag.filePath, commit);
  }, [
    activeDrag,
    handleDrop,
    options.config,
    options.notify,
    options.plannerOrderStore,
    options.refreshOrder,
    options.sortBy,
    renderedEntriesByColumn,
  ]);

  const overlayEntry = activeDrag
    ? (renderedEntriesByColumn.get(activeDrag.sourceColumnId) ?? []).find(
      (entry) => entry.entryId === activeDrag.entryId,
    )
    : undefined;

  return {
    activeDrag,
    sensors,
    overlayEntry,
    handleDrop,
    handleCardClick,
    handleRemoveRecipe,
    handleDragStart,
    handleDragEnd,
    cancelDrag: () => setActiveDrag(null),
  };
}

export { closestCenter, DndContext, DragOverlay };
