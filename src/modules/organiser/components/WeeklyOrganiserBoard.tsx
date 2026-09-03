import * as React from "react";
import type { Plan, Recipe, RecipePlanning } from "@/core";
import { createWeeklyOrganiserConfig } from "../boards/weeklyOrganiserConfig";
import { useKanbanBoard } from "../hooks/useKanbanBoard";
import { usePikadayDatePicker } from "../hooks/usePikadayDatePicker";
import { OrganiserItem } from "../types";
import { buildBoardEntries } from "../kanban/buildBoardsData";
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
import { WeeklyKanbanSurface } from "./WeeklyKanbanSurface";
import type { ReviewEntry } from "./WeeklyReviewPanel";
import type { PlannerOrderStore } from "../utils/planner-order";
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

/**
 * Weekly Organiser Board - jKanban + dragula implementation
 * GPU-accelerated drag-and-drop with zero React overhead during drag
 */
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
	const refreshColumnsRef = React.useRef<((columnIds?: string[]) => void) | null>(null);
	const rebuildBoardRef = React.useRef<(() => void) | null>(null);
	const initialFilterRefreshRef = React.useRef(true);
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
        const refreshTargets = new Set<string>(["marked", sourceColumnId]);
        if (removalResult) {
          for (const date of removalResult.remainingDates) refreshTargets.add(date);
        }
        refreshColumnsRef.current?.([...refreshTargets]);
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
		(event: MouseEvent, itemId: string, options?: { split: boolean }) => {
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

	// jKanban integration - GPU-accelerated drag-and-drop
	const { containerRef, refreshColumns, rebuild } = useKanbanBoard<OrganiserItem>({
    recipes,
    plan,
    notify,
		config,
		elementId: "weekly-organiser-kanban",
		onDrop: handleDrop,
		onCardClick: handleCardClick,
		onRemove: handleRemoveRecipe,
		runtimeFilter,
		runtimeSort,
		resolveCardImageSrc: resolveKanbanImageSrc,
		logPrefix: "WeeklyOrganiser",
		plannerOrderPresetId: "weekly",
		manualOrder: sortBy === "default",
		refreshDelayMs: 50,
		clickBlockMs: 500,
		dragCooldownMs: 300,
		plannerOrderStore,
		onBoardReady: handleBoardReady,
		onBoardError,
	});

	React.useEffect(() => {
		refreshColumnsRef.current = refreshColumns;
	}, [refreshColumns]);

	React.useEffect(() => {
		rebuildBoardRef.current = rebuild;
	}, [rebuild]);


	// Refresh when sort/filter changes
	React.useEffect(() => {
		if (initialFilterRefreshRef.current) {
			initialFilterRefreshRef.current = false;
			return;
		}
		refreshColumns();
	}, [
		sortBy,
		normalizedSearch,
		refreshColumns,
	]);

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
					.then(() => refreshColumnsRef.current?.([sourceColumnId, targetColumnId]))
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
				<WeeklyKanbanSurface
					id="weekly-organiser-kanban"
					containerRef={containerRef}
				/>
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
