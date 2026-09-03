import { recipePlanning, type Plan, type Recipe } from "@/core";
import type { OrganiserItem } from "../types";
import type { BaseKanbanItem, BoardConfig } from "../types/kanban-config";
import { applyPlannerOrder, type PlannerOrderStore } from "../utils/planner-order";

function isArchivedPath(path: string): boolean {
  const parts = path.split("/");
  parts.pop();
  return parts.some((part) => part.toLowerCase() === "archive");
}

export interface BoardEntry<T extends BaseKanbanItem> {
  entryId: string;
  filePath: string;
  item: T;
  columnId: string;
}

type BuildEntriesOptions = {
  plannerOrderStore?: PlannerOrderStore;
  plannerOrderPresetId?: string;
  manualOrder?: boolean;
};

export function buildBoardEntries(
  recipes: readonly Recipe[],
  plan: Plan,
  config: Pick<BoardConfig, "id" | "columns">,
  options: BuildEntriesOptions = {},
): {
  entriesByColumn: Map<string, BoardEntry<OrganiserItem>[]>;
  entriesByFile: Map<string, BoardEntry<OrganiserItem>>;
  entriesByItemId: Map<string, BoardEntry<OrganiserItem>>;
  entryIdsByFilePath: Map<string, Set<string>>;
} {
  const entriesByColumn = new Map(config.columns.map((column) => [column.id, [] as BoardEntry<OrganiserItem>[]]));
  const entriesByFile = new Map<string, BoardEntry<OrganiserItem>>();
  const entriesByItemId = new Map<string, BoardEntry<OrganiserItem>>();
  const entryIdsByFilePath = new Map<string, Set<string>>();
  const columnIds = new Set(config.columns.map((column) => column.id));
  const defaultColumn = config.columns.find((column) => column.isDefault)?.id;

  for (const recipe of recipes) {
    if (isArchivedPath(recipe.path)) continue;
    const planning = recipePlanning(plan, recipe.link);
    const destinations = planning.scheduledDates.filter((date) => columnIds.has(date));
    if (planning.scheduledDates.length === 0 && planning.marked && defaultColumn) destinations.push(defaultColumn);
    for (const columnId of destinations) {
      const item: OrganiserItem = {
        id: recipe.path,
        title: recipe.title,
        path: recipe.path,
        coverImage: recipe.cover ?? undefined,
        date: columnId === defaultColumn ? undefined : columnId,
        added: recipe.added ?? undefined,
        marked: planning.marked,
      };
      const entry: BoardEntry<OrganiserItem> = {
        entryId: `${recipe.path}::${columnId}`,
        filePath: recipe.path,
        item,
        columnId,
      };
      entriesByColumn.get(columnId)?.push(entry);
      if (!entriesByFile.has(recipe.path)) entriesByFile.set(recipe.path, entry);
      entriesByItemId.set(entry.entryId, entry);
      const ids = entryIdsByFilePath.get(recipe.path) ?? new Set<string>();
      ids.add(entry.entryId);
      entryIdsByFilePath.set(recipe.path, ids);
    }
  }

  for (const [columnId, entries] of entriesByColumn) {
    const persistedIds = options.manualOrder && options.plannerOrderStore && options.plannerOrderPresetId
      ? options.plannerOrderStore.get(config.id, options.plannerOrderPresetId, columnId)
      : undefined;
    entriesByColumn.set(columnId, applyPlannerOrder(entries, persistedIds));
  }

  return { entriesByColumn, entriesByFile, entriesByItemId, entryIdsByFilePath };
}
