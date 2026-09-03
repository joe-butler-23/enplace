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
import { createWeeklyOrganiserConfig } from "../boards/weeklyOrganiserConfig";
import { usePikadayDatePicker } from "../hooks/usePikadayDatePicker";
import { OrganiserItem } from "../types";
import { buildBoardEntries, type BoardEntry } from "../kanban/buildBoardsData";
import {
  laneClassNameFor,
  resolveOrganiserDrop,
} from "../kanban/dropPolicy";
import {
	appendCookLogEntryToFile,
	CookLogEntryInput,
} from "../../cooking/services/RecipeLogService";
import {
	computeWeeklyTrackWidth,
	MIN_WEEKLY_COLUMN_WIDTH_PX,
	normalizeWeeklyColumnMinWidth,
} from "../utils/weekly-layout";
import {
  addCalendarDays,
  calendarWeekOffset,
  dateFromIso,
  formatIsoDate,
  formatPlannerDate,
  normalizeFrontmatterDate,
  startOfIsoWeek,
} from "../utils/scheduled-dates";
import {
	isIsoDateString,
	removeRecipeScheduledDateOccurrence,
	type RecipeDateRemovalResult,
} from "../utils/recipe-schedule-actions";
import { removePlannerRecipe } from "../utils/planner-recipe-removal";
import { resolveFilePathFromItemId } from "../utils/item-id";
import {
	OrganiserToolbar,
	type OrganiserToolbarCalendar,
	type OrganiserToolbarPopovers,
	type OrganiserToolbarWeekNav,
} from "./OrganiserToolbar";
import { WeeklyReviewPanel } from "./WeeklyReviewPanel";
import type { ColumnDefinition } from "../types/kanban-config";
import type { ReviewEntry } from "./WeeklyReviewPanel";
import { plannerOrderKey, type PlannerOrderStore } from "../utils/planner-order";
import { selectWeeklyShoppingRecipePaths } from "../utils/weekly-shopping-selection";
import type {
	PlannerBoardIdentity,
	PlannerLaneIdentity,
} from "@/standalone/planner-transition-evidence";


interface WeeklyOrganiserBoardProps {
  recipes: readonly Recipe[];
  plan: Plan;
  updatePlanning: (path: string, update: (planning: RecipePlanning) => RecipePlanning) => Promise<void>;
  notify: (message: string) => void;
  resolveCover: (coverPath: string | null, sourcePath: string) => string | null;
	dayNotes?: Record<string, string>;
	onSendShoppingList?: (payload: WeeklyOrganiserShoppingListPayload) => void;
	onSaveDayNote?: (date: string, note: string) => void;
	onOpenFile: (filePath: string, options: { split: boolean }) => void;
	markedWidth?: number;
	onSaveMarkedWidth?: (width: number) => void;
	onUnmarkRecipe: (path: string) => Promise<void>;
	plannerOrderStore?: PlannerOrderStore;
	onBoardReady?: (identity: PlannerBoardIdentity) => void;
	onBoardError?: (error: unknown) => void;
}

export type WeeklyOrganiserShoppingListPayload = {
	recipePaths: string[];
	weekLabel: string;
	weekOffset: number;
};

type MarkedColumnResizeSession = {
	startX: number;
	startMinWidth: number;
	startWidth: number;
};

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

function PlannerCard({ entry, coverUrl, overlay = false, onOpen, onRemove }: PlannerCardProps): React.JSX.Element {
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
      {...(!overlay ? ({ elementtiming: `mep:planner-card:${entry.entryId}` } as React.HTMLAttributes<HTMLDivElement>) : {})}
      style={{ transform, visibility: sortable.isDragging ? "hidden" : undefined }}
    >
      <div className="organiser-card-content">
        <button
          className="card-remove-btn"
          data-kanban-action="remove-recipe"
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
          <span
            className="card-title"
            {...(!overlay ? ({ elementtiming: `mep:planner-card-title:${entry.entryId}` } as React.HTMLAttributes<HTMLSpanElement>) : {})}
          >
            {entry.item.title}
          </span>
        </button>
      </div>
    </div>
  );
}

type PlannerLaneProps = {
  column: ColumnDefinition;
  index: number;
  entries: BoardEntry<OrganiserItem>[];
  resolveCover: (entry: BoardEntry<OrganiserItem>) => string;
  onOpen: (event: React.MouseEvent, path: string) => void;
  onRemove: (path: string, sourceColumnId: string) => void;
};

function PlannerLane({ column, index, entries, resolveCover, onOpen, onRemove }: PlannerLaneProps): React.JSX.Element {
  const { setNodeRef } = useDroppable({ id: column.id, data: { type: "lane", laneId: column.id } });
  const densityClass = column.id !== "marked" && entries.length > 1 ? " kanban-board--multi-recipe" : "";
  const headerClass = laneClassNameFor(column.id);
  return (
    <div
      ref={setNodeRef}
      className={`kanban-board${densityClass}`}
      data-id={column.id}
      data-order={index + 1}
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
      <footer />
    </div>
  );
}

let nextPlannerDropGeneration = 0;

async function updateScheduledDatesForDrop(
  path: string,
  targetColumnId: string,
  options: { sourceColumnId?: string; duplicate?: boolean },
  updatePlanning: WeeklyOrganiserBoardProps["updatePlanning"],
): Promise<void> {
  await updatePlanning(path, (planning) => {
    const nextDates = [...planning.scheduledDates];
    if (
      options.duplicate !== true
      && options.sourceColumnId
      && isIsoDateString(options.sourceColumnId)
      && options.sourceColumnId !== targetColumnId
    ) {
      const sourceIndex = nextDates.indexOf(options.sourceColumnId);
      if (sourceIndex !== -1) nextDates.splice(sourceIndex, 1);
    }
    if (!nextDates.includes(targetColumnId)) nextDates.push(targetColumnId);
    return { marked: false, scheduledDates: nextDates.sort((a, b) => a.localeCompare(b)) };
  });
}

function runInSequence<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
	return items.reduce((chain, item) => chain.then(() => task(item)), Promise.resolve());
}

const SORT_OPTIONS = [
	{ id: "default", label: "Default" },
	{ id: "title-asc", label: "Title A-Z" },
	{ id: "title-desc", label: "Title Z-A" },
	{ id: "added-desc", label: "Added (newest)" },
	{ id: "added-asc", label: "Added (oldest)" },
];
function normalizeReviewDate(value?: string): string {
	return normalizeFrontmatterDate(value, { onInvalid: "" }) ?? "";
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
	onBoardReady,
	onBoardError,
}: WeeklyOrganiserBoardProps): React.JSX.Element {
	const [currentMarkedWidth, setCurrentMarkedWidth] = React.useState(() =>
		normalizeWeeklyColumnMinWidth(markedWidth)
	);
	const [resizeSession, setResizeSession] = React.useState<MarkedColumnResizeSession | null>(null);

	React.useEffect(() => {
		setCurrentMarkedWidth(normalizeWeeklyColumnMinWidth(markedWidth));
	}, [markedWidth]);

	const [searchQuery, setSearchQuery] = React.useState("");
	const [activePopover, setActivePopover] = React.useState<
		"filter" | "sort" | null
	>(null);
	const [sortBy, setSortBy] = React.useState("default");
	const [showTimeControls, setShowTimeControls] = React.useState(true);
	const [weekOffset, setWeekOffset] = React.useState(0);
	const [isCalendarOpen, setIsCalendarOpen] = React.useState(false);
	const [isReviewOpen, setIsReviewOpen] = React.useState(false);
	const [reviewEntries, setReviewEntries] = React.useState<ReviewEntry[]>([]);
	const [isReviewSaving, setIsReviewSaving] = React.useState(false);
  const [activeDrag, setActiveDrag] = React.useState<PlannerDrag | null>(null);
  const [orderRevision, setOrderRevision] = React.useState(0);
  const dropQueuesRef = React.useRef(new Map<string, Promise<void>>());
	const plannerRootRef = React.useRef<HTMLDivElement>(null);
	const topbarRef = React.useRef<HTMLDivElement>(null);
	const reviewPanelRef = React.useRef<HTMLDivElement>(null);
	const kanbanRef = React.useRef<HTMLDivElement>(null);
	const calendarInputRef = React.useRef<HTMLInputElement>(null);
	const calendarPopoverRef = React.useRef<HTMLDivElement>(null);
	const calendarToggleRef = React.useRef<HTMLButtonElement>(null);
	const filterButtonRef = React.useRef<HTMLButtonElement>(null);
	const filterPopoverRef = React.useRef<HTMLDivElement>(null);
	const sortButtonRef = React.useRef<HTMLButtonElement>(null);
	const sortPopoverRef = React.useRef<HTMLDivElement>(null);

  const resolveKanbanImageSrc = React.useCallback(
    (item: OrganiserItem) => resolveCover(item.coverImage ?? null, item.path) ?? "",
    [resolveCover]
  );

	const saveMarkedWidth = React.useEffectEvent((width: number) => {
		onSaveMarkedWidth?.(width);
	});
	const isResizingMarked = resizeSession !== null;

	const clampHorizontalScroll = React.useCallback((element: HTMLElement | null) => {
		if (!element) return;
		const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
		if (maxScrollLeft <= 0) {
			if (element.scrollLeft !== 0) {
				element.scrollLeft = 0;
			}
			return;
		}
		if (element.scrollLeft < 0) {
			element.scrollLeft = 0;
			return;
		}
		if (element.scrollLeft > maxScrollLeft) {
			element.scrollLeft = maxScrollLeft;
		}
	}, []);

	React.useEffect(() => {
		if (typeof ResizeObserver === "undefined") return;
		const plannerRoot = plannerRootRef.current;
		const kanbanHost = kanbanRef.current;
		const mainPane = plannerRoot?.closest(".mep-main--planner") as HTMLElement | null;
		const targets = [mainPane, plannerRoot, kanbanHost].filter(
			(value): value is HTMLElement => Boolean(value)
		);
		if (targets.length === 0) return;

		const clampAll = () => {
			for (const target of targets) {
				clampHorizontalScroll(target);
			}
		};

		const observer = new ResizeObserver(() => clampAll());
		for (const target of targets) {
			observer.observe(target);
		}
		window.addEventListener("resize", clampAll);
		clampAll();
		return () => {
			window.removeEventListener("resize", clampAll);
			observer.disconnect();
		};
	}, [clampHorizontalScroll]);

	const handleResizeStart = (e: React.MouseEvent) => {
		e.preventDefault();
		const startHostWidth = kanbanRef.current?.clientWidth ?? 0;
		setResizeSession({
			startX: e.clientX,
			startMinWidth: currentMarkedWidth,
			startWidth: computeWeeklyTrackWidth(startHostWidth, currentMarkedWidth),
		});
	};

	const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const delta = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
		if (!delta) return;
		event.preventDefault();
		const nextWidth = normalizeWeeklyColumnMinWidth(currentMarkedWidth + delta);
		if (nextWidth === currentMarkedWidth) return;
		setCurrentMarkedWidth(nextWidth);
		saveMarkedWidth(nextWidth);
	};

	React.useEffect(() => {
		if (!resizeSession) return;
		const handleMouseMove = (event: MouseEvent) => {
			const diff = event.clientX - resizeSession.startX;
			const nextWidth = normalizeWeeklyColumnMinWidth(resizeSession.startWidth + diff);
			setCurrentMarkedWidth(nextWidth);
		};
		const handleMouseUp = (event: MouseEvent) => {
			const diff = event.clientX - resizeSession.startX;
			setResizeSession(null);
			if (Math.abs(diff) < 1) {
				return;
			}
			const finalWidth = normalizeWeeklyColumnMinWidth(resizeSession.startWidth + diff);
			setCurrentMarkedWidth(finalWidth);
			if (finalWidth !== resizeSession.startMinWidth) {
				saveMarkedWidth(finalWidth);
			}
		};
		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);
		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
		};
	}, [resizeSession]);

	const config = React.useMemo(
		() => createWeeklyOrganiserConfig(weekOffset, dayNotes),
		[weekOffset, dayNotes]
	);

	const loadReviewEntries = React.useCallback((): ReviewEntry[] => {
		const { entriesByFile } = buildBoardEntries(recipes, plan, config);

		return Array.from(entriesByFile.values())
			.filter((entry) => entry.item.date)
			.sort((a, b) =>
				(a.item.date ?? "").localeCompare(b.item.date ?? "")
			)
			.map((entry) => {
				const scheduledDate = entry.item.date ?? "";
				const cookedDate = normalizeReviewDate(entry.item.date);
				const coverUrl = resolveKanbanImageSrc(entry.item);
				return {
					path: entry.filePath,
					title: entry.item.title,
					scheduledDate,
					cookedDate,
					coverUrl,
					rating: "",
					makeAgain: "",
					notes: "",
					include: true,
				};
			});
	}, [config, plan, recipes, resolveKanbanImageSrc]);

	React.useEffect(() => {
		if (!isReviewOpen) return;
		setReviewEntries(loadReviewEntries());
	}, [isReviewOpen, loadReviewEntries]);

	const updateReviewEntry = React.useCallback(
		(path: string, updates: Partial<ReviewEntry>) => {
			setReviewEntries((prev) =>
				prev.map((entry) =>
					entry.path === path ? { ...entry, ...updates } : entry
				)
			);
		},
		[]
	);

	const handleDrop = React.useCallback(
		async (
			itemId: string,
			targetColumnId: string,
			options?: {
				sourceColumnId?: string;
				duplicate?: boolean;
				order?: {
					sourceColumnId?: string;
					targetColumnId: string;
					sourceEntryIds: string[];
					targetEntryIds: string[];
				};
			}
		) => {
      if (!recipes.some((recipe) => recipe.path === itemId)) return;
			const targetColumn = config.columns.find((column) => column.id === targetColumnId);
      if (!targetColumn) return;
      const duplicateDrop = options?.duplicate === true && !targetColumn.isDefault;
      const sourceColumnId = options?.sourceColumnId;
      if (!duplicateDrop && targetColumn.isDefault && isIsoDateString(sourceColumnId)) {
        const removalState: { result: RecipeDateRemovalResult | null } = { result: null };
        await updatePlanning(itemId, (current) => {
          const next = { ...current, scheduledDates: [...current.scheduledDates] };
          removalState.result = removeRecipeScheduledDateOccurrence(next, sourceColumnId);
          return next;
        });
        const removalResult = removalState.result;
        console.info("planner_drop_recipe_to_marked", {
          filePath: itemId,
          sourceColumnId,
          targetColumnId,
          result: removalResult,
          refreshColumns: ["marked", sourceColumnId],
        });
        if (removalResult && !removalResult.marked) return { deleted: true };
        return;
      }
      if (isIsoDateString(targetColumnId)) {
        await updateScheduledDatesForDrop(itemId, targetColumnId, {
          sourceColumnId,
          duplicate: duplicateDrop,
        }, updatePlanning);
        return;
      }
      if (targetColumn.isDefault) {
        await updatePlanning(itemId, () => ({ marked: true, scheduledDates: [] }));
      }
		},
		[config, recipes, updatePlanning]
	);

	const handleCardClick = React.useCallback(
    (event: React.MouseEvent, itemId: string, options?: { split: boolean }) => {
      if (!recipes.some((recipe) => recipe.path === itemId)) return;
			const split = options?.split ?? (event.ctrlKey || event.metaKey);
      onOpenFile(itemId, { split });
		},
		[onOpenFile, recipes]
	);

	const handleRemoveRecipe = React.useCallback(
		async (itemId: string, options?: { sourceColumnId?: string }) => {
      if (!recipes.some((recipe) => recipe.path === itemId)) return;
			const sourceColumnId = options?.sourceColumnId;
			await removePlannerRecipe(
				sourceColumnId,
				async (date) => {
          let result: RecipeDateRemovalResult | null = null;
          await updatePlanning(itemId, (current) => {
            const next = { ...current, scheduledDates: [...current.scheduledDates] };
            result = removeRecipeScheduledDateOccurrence(next, date, { markWhenEmpty: false });
            return next;
          });
          console.info("planner_remove_recipe_date_occurrence", {
            filePath: itemId,
            sourceColumnId: date,
            result,
          });
				},
				() => onUnmarkRecipe(itemId)
			);
		},
		[onUnmarkRecipe, recipes, updatePlanning]
	);

	const deferredSearchQuery = React.useDeferredValue(searchQuery);
	const normalizedSearch = React.useMemo(
		() => deferredSearchQuery.trim().toLowerCase(),
		[deferredSearchQuery]
	);

	const runtimeFilter = React.useCallback(
		(item: OrganiserItem) => {
			if (!normalizedSearch) return true;
			return (
				item.title.toLowerCase().includes(normalizedSearch) ||
				item.path.toLowerCase().includes(normalizedSearch)
			);
		},
		[normalizedSearch]
	);

	const runtimeSort = React.useMemo(() => {
		return (a: OrganiserItem, b: OrganiserItem) => {
			if (sortBy === "title-asc") {
				return a.title.localeCompare(b.title);
			}
			if (sortBy === "title-desc") {
				return b.title.localeCompare(a.title);
			}
			if (sortBy === "added-asc" || sortBy === "added-desc") {
				const aDate = a.added ?? "";
				const bDate = b.added ?? "";
				const aHasDate = aDate.length > 0;
				const bHasDate = bDate.length > 0;
				if (!aHasDate && !bHasDate) return 0;
				if (!aHasDate) return 1;
				if (!bHasDate) return -1;
				if (sortBy === "added-desc") {
					if (aDate > bDate) return -1;
					if (aDate < bDate) return 1;
					return 0;
				}
				if (aDate < bDate) return -1;
				if (aDate > bDate) return 1;
				return 0;
			}
			return 0;
		};
	}, [sortBy]);

	const isTimeRowVisible = showTimeControls;

	// Week navigation identity is also the authoritative transition evidence scope.
	const startDate = addCalendarDays(startOfIsoWeek(), weekOffset * 7);
	const endDate = addCalendarDays(startDate, 6);
	const weekRangeDisplay = `${formatPlannerDate(startDate, false, false)} - ${formatPlannerDate(endDate, false, true)}`;
	const startDateValue = formatIsoDate(startDate);
	const endDateValue = formatIsoDate(endDate);
	const handleBoardReady = React.useCallback((lanes: PlannerLaneIdentity[]) => {
		onBoardReady?.({
			presetId: "weekly",
			weekStart: startDateValue,
			weekEnd: endDateValue,
			lanes,
		});
	}, [endDateValue, onBoardReady, startDateValue]);

	React.useEffect(() => {
		if (!isTimeRowVisible && isCalendarOpen) {
			setIsCalendarOpen(false);
		}
	}, [isCalendarOpen, isTimeRowVisible]);

  const sensors = useSensors(useSensor(PointerSensor, {
    activationConstraint: { distance: 5 },
  }));

  const renderedEntriesByColumn = React.useMemo(() => {
    const { entriesByColumn } = buildBoardEntries(recipes, plan, config, {
      plannerOrderStore,
      plannerOrderPresetId: "weekly",
      manualOrder: sortBy === "default",
    });
    const rendered = new Map<string, BoardEntry<OrganiserItem>[]>();
    for (const column of config.columns) {
      const filtered = (entriesByColumn.get(column.id) ?? []).filter(({ item }) => runtimeFilter(item));
      rendered.set(column.id, runtimeSort ? [...filtered].sort((a, b) => runtimeSort(a.item, b.item)) : filtered);
    }
    return rendered;
  }, [config, orderRevision, plan, plannerOrderStore, recipes, runtimeFilter, runtimeSort, sortBy]);

  const laneIdentities = React.useMemo<PlannerLaneIdentity[]>(() => config.columns.map((column) => ({
    id: column.id,
    cardIds: (renderedEntriesByColumn.get(column.id) ?? []).map((entry) => entry.entryId),
  })), [config.columns, renderedEntriesByColumn]);

  React.useLayoutEffect(() => {
    try {
      handleBoardReady(laneIdentities);
    } catch (error) {
      onBoardError?.(error);
    }
  }, [handleBoardReady, laneIdentities, onBoardError]);

  const resolveEntryCover = React.useCallback(
    (entry: BoardEntry<OrganiserItem>) => resolveKanbanImageSrc(entry.item),
    [resolveKanbanImageSrc],
  );

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
    if (!config.columns.some((column) => column.id === targetColumnId)) return;

    const outcome = resolveOrganiserDrop({
      cardId: drag.entryId,
      sourceLaneId: drag.sourceColumnId,
      targetLaneId: targetColumnId,
      isTemplate: false,
      duplicateModifier: drag.duplicate,
    });
    if (outcome === "reject" || outcome === "remove") return;
    const duplicate = outcome === "copy";
    const targetEntryId = `${drag.filePath}::${targetColumnId}`;
    const sourceIds = (renderedEntriesByColumn.get(drag.sourceColumnId) ?? []).map((entry) => entry.entryId);
    const currentTargetIds = (renderedEntriesByColumn.get(targetColumnId) ?? []).map((entry) => entry.entryId);
    if (duplicate && currentTargetIds.includes(targetEntryId)) return;

    const overIndex = currentTargetIds.indexOf(String(event.over.id));
    const afterOver = overIndex >= 0
      && event.active.rect.current.translated !== null
      && event.active.rect.current.translated.top > event.over.rect.top + event.over.rect.height / 2;
    const insertionIndex = overIndex < 0
      ? currentTargetIds.length
      : Math.min(currentTargetIds.length, overIndex + (afterOver ? 1 : 0));

    let nextSourceIds: string[];
    let nextTargetIds: string[];
    if (drag.sourceColumnId === targetColumnId) {
      const fromIndex = sourceIds.indexOf(drag.entryId);
      const destination = insertionIndex > fromIndex ? insertionIndex - 1 : insertionIndex;
      const toIndex = Math.max(0, Math.min(sourceIds.length - 1, destination));
      if (fromIndex < 0 || fromIndex === toIndex) return;
      nextSourceIds = arrayMove(sourceIds, fromIndex, toIndex);
      nextTargetIds = nextSourceIds;
    } else {
      nextSourceIds = duplicate ? sourceIds : sourceIds.filter((id) => id !== drag.entryId);
      const existingTargetIndex = currentTargetIds.indexOf(targetEntryId);
      const targetWithoutEntry = currentTargetIds.filter((id) => id !== targetEntryId);
      const adjustedInsertionIndex = existingTargetIndex >= 0 && existingTargetIndex < insertionIndex
        ? insertionIndex - 1
        : insertionIndex;
      const targetIndex = Math.min(adjustedInsertionIndex, targetWithoutEntry.length);
      nextTargetIds = [...targetWithoutEntry.slice(0, targetIndex), targetEntryId, ...targetWithoutEntry.slice(targetIndex)];
    }

    const previous = dropQueuesRef.current.get(drag.filePath) ?? Promise.resolve();
    const commit = previous.catch(() => undefined).then(async () => {
      const result = drag.sourceColumnId === targetColumnId
        ? undefined
        : await handleDrop(drag.filePath, targetColumnId, {
          sourceColumnId: drag.sourceColumnId,
          duplicate,
        });
      if (result?.deleted === true) nextTargetIds = nextTargetIds.filter((id) => id !== targetEntryId);
      if (sortBy === "default" && plannerOrderStore) {
        const updates = new Map<string, readonly string[]>();
        updates.set(plannerOrderKey(config.id, "weekly", drag.sourceColumnId), nextSourceIds);
        updates.set(plannerOrderKey(config.id, "weekly", targetColumnId), nextTargetIds);
        await plannerOrderStore.replaceMany(updates);
        setOrderRevision((value) => value + 1);
      }
      performance.mark("mep:planner:drop-settled", { detail: {
        generation: ++nextPlannerDropGeneration,
        itemId: drag.filePath,
        sourceLaneId: drag.sourceColumnId,
        targetLaneId: targetColumnId,
        targetEntryId,
        presentationIdentifier: `mep:planner-card-title:${targetEntryId}`,
      }});
    }).catch((error) => {
      console.error("[WeeklyOrganiser] Failed to move recipe", error);
      notify("Could not move recipe. Please try again.");
    }).finally(() => {
      if (dropQueuesRef.current.get(drag.filePath) === commit) dropQueuesRef.current.delete(drag.filePath);
    });
    dropQueuesRef.current.set(drag.filePath, commit);
  }, [activeDrag, config.columns, config.id, handleDrop, notify, plannerOrderStore, renderedEntriesByColumn, sortBy]);

	const handleColumnNoteAction = React.useCallback(
		async (event: React.MouseEvent, date: string) => {
			event.stopPropagation();
			event.preventDefault();

			if (!onSaveDayNote) return;
			const currentNote = dayNotes?.[date] ?? "";
			const newNote = window.prompt("Enter note for this day:", currentNote);

			if (newNote !== null && newNote !== currentNote) {
				onSaveDayNote(date, newNote.trim());
			}
		},
		[dayNotes, onSaveDayNote]
	);

	const handleSendShoppingList = React.useCallback(() => {
		if (!onSendShoppingList) return;
		const { entriesByFile } = buildBoardEntries(recipes, plan, config);
		const recipePaths = selectWeeklyShoppingRecipePaths(
			entriesByFile.values(),
			startDateValue,
			endDateValue
		);
		if (recipePaths.length === 0) {
			notify("No scheduled recipes found for this week.");
			return;
		}
		onSendShoppingList({
			recipePaths,
			weekLabel: weekRangeDisplay,
			weekOffset,
		});
	}, [
		config,
		endDateValue,
    notify,
		onSendShoppingList,
    plan,
    recipes,
		startDateValue,
		weekOffset,
		weekRangeDisplay,
	]);

	const handleToggleReview = React.useCallback(() => {
		setIsReviewOpen((prev) => !prev);
	}, []);

	const handleToggleCalendar = React.useCallback(() => {
		setIsCalendarOpen((prev) => !prev);
	}, []);
	const handlePreviousWeek = React.useCallback(() => {
		setWeekOffset((prev) => prev - 1);
	}, []);
	const handleNextWeek = React.useCallback(() => {
		setWeekOffset((prev) => prev + 1);
	}, []);
	const handleResetWeek = React.useCallback(() => {
		setWeekOffset(0);
	}, []);

	const handleCompleteWeek = React.useCallback(async () => {
		if (isReviewSaving) return;
		if (reviewEntries.length === 0) {
			notify("No scheduled recipes found for this week.");
			return;
		}
		const logCount = reviewEntries.filter(
			(entry) => entry.include && entry.cookedDate.trim().length > 0
		).length;
		const confirmMessage = logCount > 0
			? `Save ${logCount} review${logCount === 1 ? "" : "s"} and clear scheduled recipes for ${weekRangeDisplay}?`
			: `Clear scheduled recipes for ${weekRangeDisplay}?`;
		if (!confirm(confirmMessage)) return;

		setIsReviewSaving(true);
		try {
			let loggedCount = 0;
			let clearedCount = 0;
			await runInSequence(reviewEntries, async (entry) => {
				if (!entry.include) return;
				const cookedDate = entry.cookedDate.trim();
				if (!cookedDate || !recipes.some((recipe) => recipe.path === entry.path)) return;
				const ratingValue = entry.rating ? Number(entry.rating) : null;
				const rating = ratingValue !== null && Number.isNaN(ratingValue) ? null : ratingValue;
				const makeAgain = entry.makeAgain === "" ? null : entry.makeAgain === "yes";
				const logEntry: CookLogEntryInput = {
					cookedDate,
					rating,
					makeAgain,
					notes: entry.notes,
				};
				try {
					await appendCookLogEntryToFile(entry.path, logEntry);
					loggedCount += 1;
				} catch (error) {
					console.error("Failed to append cook log", { path: entry.path, error });
				}
			});

			await runInSequence(reviewEntries, async (entry) => {
        if (!recipes.some((recipe) => recipe.path === entry.path)) return;
				try {
          await updatePlanning(entry.path, (current) => ({ ...current, scheduledDates: [] }));
					clearedCount += 1;
				} catch (error) {
					console.error("Failed to clear scheduled date", { path: entry.path, error });
				}
			});

			notify(`Logged ${loggedCount} recipe${loggedCount === 1 ? "" : "s"}, cleared ${clearedCount}.`);
			setIsReviewOpen(false);
			setWeekOffset((prev) => prev + 1);
		} catch (error) {
			console.error("Weekly review failed", error);
			notify("Weekly review failed. Check console for details.");
		} finally {
			setIsReviewSaving(false);
		}
	}, [isReviewSaving, notify, recipes, reviewEntries, updatePlanning, weekRangeDisplay]);

	const handleCalendarSelect = React.useCallback((date: Date) => {
		if (!date || Number.isNaN(date.getTime())) return;
		setWeekOffset(calendarWeekOffset(date));
		setIsCalendarOpen(false);
	}, []);
	const handleCalendarClose = React.useCallback(() => {
		setIsCalendarOpen(false);
	}, []);
	const calendarSelectedDate = React.useMemo(
		() => dateFromIso(startDateValue),
		[startDateValue]
	);

		const { gotoToday, clear: clearCalendarSelection } = usePikadayDatePicker({
			isOpen: isCalendarOpen,
			inputRef: calendarInputRef,
			containerRef: calendarPopoverRef,
			selectedDate: calendarSelectedDate,
			onSelect: handleCalendarSelect,
			onClose: handleCalendarClose,
		});
		const handleCalendarClear = React.useCallback(() => {
			clearCalendarSelection();
			setWeekOffset(0);
			setIsCalendarOpen(false);
		}, [clearCalendarSelection]);

	// Close calendar when clicking outside
	React.useEffect(() => {
		if (!isCalendarOpen) return;

		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			const popover = calendarPopoverRef.current;
			const toggle = calendarToggleRef.current;

			const isInsidePopover = popover?.contains(target);
			const isInsideToggle = toggle?.contains(target);

			let el: HTMLElement | null = target;
			let isInsidePikaday = false;
			while (el) {
				if (el.className && typeof el.className === "string" && el.className.includes("pika")) {
					isInsidePikaday = true;
					break;
				}
				el = el.parentElement;
			}

			if (!isInsidePopover && !isInsideToggle && !isInsidePikaday) {
				setIsCalendarOpen(false);
			}
		};

		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [isCalendarOpen]);

	React.useEffect(() => {
		if (!activePopover) return;

		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as HTMLElement;

			const isInside = (ref: React.RefObject<HTMLElement | null>) =>
				Boolean(ref.current?.contains(target));

			const popoverRefs = {
				filter: {
					button: filterButtonRef,
					panel: filterPopoverRef,
				},
				sort: {
					button: sortButtonRef,
					panel: sortPopoverRef,
				},
			};

			const activeRefs = popoverRefs[activePopover];
			if (
				isInside(activeRefs.button) ||
				isInside(activeRefs.panel)
			) {
				return;
			}

			setActivePopover(null);
		};

		document.addEventListener("mousedown", handleClickOutside);
		return () =>
			document.removeEventListener("mousedown", handleClickOutside);
	}, [activePopover]);

	const togglePopover = React.useCallback(
		(name: "filter" | "sort") => {
			setActivePopover((prev) => (prev === name ? null : name));
		},
		[]
	);

	const handleSortChange = React.useCallback((next: string) => {
		setSortBy(next);
		setActivePopover(null);
	}, []);

	const handleKanbanClickCapture = React.useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			const target = event.target as HTMLElement | null;
			if (!target) return;
			const noteButton = target.closest(".organiser-column-note") as HTMLElement | null;
			if (!noteButton) return;
			const date = noteButton.dataset.date;
			if (!date) return;
			void handleColumnNoteAction(event, date);
		},
		[handleColumnNoteAction]
	);
	const handleKanbanKeyDownCapture = React.useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest(".card-open-btn")) {
				const card = target?.closest(".kanban-item") as HTMLElement | null;
				if (!card?.dataset.eid || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
				const sourceColumnId = card.closest(".kanban-board")?.getAttribute("data-id");
				const sourceIndex = config.columns.findIndex((column) => column.id === sourceColumnId);
				const targetColumnId = config.columns[sourceIndex + (event.key === "ArrowLeft" ? -1 : 1)]?.id;
				if (!sourceColumnId || !targetColumnId) return;
				event.preventDefault();
				void handleDrop(resolveFilePathFromItemId(card.dataset.eid), targetColumnId, { sourceColumnId })
					.catch(() => notify("Could not move recipe. Please try again."));
				return;
			}
			if (event.key !== "Enter" && event.key !== " ") return;
			const noteButton = target?.closest(".organiser-column-note") as HTMLElement | null;
			const date = noteButton?.dataset.date;
			if (!date) return;
			event.preventDefault();
			void handleColumnNoteAction(event as unknown as React.MouseEvent<HTMLDivElement>, date);
		},
		[config.columns, handleColumnNoteAction, handleDrop, notify]
	);

	const isFilterActive = !showTimeControls;
	const isSortActive = sortBy !== "default";

	const calendarControls = React.useMemo<OrganiserToolbarCalendar>(
		() => ({
			isOpen: isCalendarOpen,
			isTimeRowVisible,
			startDateValue,
			inputRef: calendarInputRef,
			popoverRef: calendarPopoverRef,
			toggleRef: calendarToggleRef,
			onToggle: handleToggleCalendar,
			onGotoToday: gotoToday,
			onClearDate: handleCalendarClear,
		}),
		[
			calendarInputRef,
			calendarPopoverRef,
			calendarToggleRef,
			gotoToday,
			handleCalendarClear,
			handleToggleCalendar,
			isCalendarOpen,
			isTimeRowVisible,
			startDateValue,
		]
	);
	const weekNavControls = React.useMemo<OrganiserToolbarWeekNav>(
		() => ({
			onPrevWeek: handlePreviousWeek,
			onNextWeek: handleNextWeek,
			onResetWeek: handleResetWeek,
			weekRangeDisplay,
		}),
		[handleNextWeek, handlePreviousWeek, handleResetWeek, weekRangeDisplay]
	);
	const popoverControls = React.useMemo<OrganiserToolbarPopovers>(
		() => ({
			filterButtonRef,
			filterPopoverRef,
			sortButtonRef,
			sortPopoverRef,
			activePopover,
			onToggle: togglePopover,
			showTimeControls,
			onToggleShowTimeControls: setShowTimeControls,
			sortOptions: SORT_OPTIONS,
			sortBy,
			onSortChange: handleSortChange,
			isFilterActive,
			isSortActive,
		}),
		[
			activePopover,
			filterButtonRef,
			filterPopoverRef,
			handleSortChange,
			isFilterActive,
			isSortActive,
			sortBy,
			sortButtonRef,
			sortPopoverRef,
			showTimeControls,
			togglePopover,
		]
	);

  const overlayEntry = activeDrag
    ? (renderedEntriesByColumn.get(activeDrag.sourceColumnId) ?? []).find((entry) => entry.entryId === activeDrag.entryId)
    : undefined;

	return (
		<div
			ref={plannerRootRef}
			className="weekly-organiser-container"
			// @ts-expect-error elementtiming is a valid Element Timing API attribute.
			elementtiming="mep:planner-shell"
		>
			<OrganiserToolbar
				topbarRef={topbarRef}
				searchQuery={searchQuery}
				onSearchChange={setSearchQuery}
				calendar={calendarControls}
				weekNav={weekNavControls}
				onSendShoppingList={onSendShoppingList ? handleSendShoppingList : undefined}
				isReviewOpen={isReviewOpen}
				onToggleReview={handleToggleReview}
				popovers={popoverControls}
			/>
			{isReviewOpen && (
				<WeeklyReviewPanel
					entries={reviewEntries}
					isSaving={isReviewSaving}
					weekRangeDisplay={weekRangeDisplay}
					panelRef={reviewPanelRef}
					onClose={() => setIsReviewOpen(false)}
					onCompleteWeek={handleCompleteWeek}
					onUpdateEntry={updateReviewEntry}
				/>
			)}
			<div
				className="weekly-organiser-kanban"
				role="region"
				aria-label="Weekly organiser board"
				ref={kanbanRef}
				style={{
					position: "relative",
					"--col-min-width": `${currentMarkedWidth}px`,
				} as React.CSSProperties}
					onClickCapture={handleKanbanClickCapture}
					onKeyDownCapture={handleKanbanKeyDownCapture}
			>
        <div
          id="weekly-organiser-kanban"
          className={`weekly-organiser-kanban-host${activeDrag ? " is-board-dragging" : ""}`}
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setActiveDrag(null)}
          >
            <div className="kanban-container">
              {config.columns.map((column, index) => (
                <PlannerLane
                  key={column.id}
                  column={column}
                  index={index}
                  entries={renderedEntriesByColumn.get(column.id) ?? []}
                  resolveCover={resolveEntryCover}
                  onOpen={handleCardClick}
                  onRemove={(path, sourceColumnId) => {
                    void handleRemoveRecipe(path, { sourceColumnId }).catch(() =>
                      notify("Could not remove recipe. Please try again."),
                    );
                  }}
                />
              ))}
            </div>
            <DragOverlay dropAnimation={null} style={{ pointerEvents: "none" }}>
              {overlayEntry ? (
                <PlannerCard
                  entry={overlayEntry}
                  coverUrl={resolveEntryCover(overlayEntry)}
                  overlay
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
				<div
					className={`marked-col-resizer${
						isResizingMarked ? " is-resizing" : ""
					}`}
					role="separator"
					aria-label="Resize marked column"
					aria-orientation="vertical"
					aria-valuemin={MIN_WEEKLY_COLUMN_WIDTH_PX}
					aria-valuenow={currentMarkedWidth}
					aria-valuetext={`${currentMarkedWidth} pixels`}
					tabIndex={0}
					onMouseDown={handleResizeStart}
					onKeyDown={handleResizeKeyDown}
				/>
			</div>
			</div>
	);
});
