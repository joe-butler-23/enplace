import * as React from "react";
import { App, Notice, TFile, WorkspaceLeaf, moment, normalizePath } from "@/platform";
import { createWeeklyOrganiserConfig } from "../boards/weeklyOrganiserConfig";
import { resolveCoverImage } from "../utils/resolveCoverImage";
import { useKanbanBoard } from "../hooks/useKanbanBoard";
import { usePikadayDatePicker } from "../hooks/usePikadayDatePicker";
import {
	findPresetById,
	OrganiserPreset,
	OrganiserPresetId,
} from "../presets/organiserPresets";
import { OrganiserItem } from "../types";
import { buildBoardEntries } from "../kanban/buildBoardsData";
import { FieldManager } from "../utils/field-manager";
import {
	appendCookLogEntryToFile,
	CookLogEntryInput,
} from "../../cooking/services/RecipeLogService";
import {
	computeWeeklyTrackWidth,
	normalizeWeeklyColumnMinWidth,
} from "../utils/weekly-layout";
import {
	readScheduledDateList,
	writeScheduledDateList,
	normalizeFrontmatterDate,
} from "../utils/scheduled-dates";
import {
	isIsoDateString,
	removeRecipeScheduledDateOccurrence,
	type RecipeDateRemovalResult,
} from "../utils/recipe-schedule-actions";
import { removePlannerRecipe } from "../utils/planner-recipe-removal";
import {
	OrganiserToolbar,
	type OrganiserToolbarCalendar,
	type OrganiserToolbarPopovers,
	type OrganiserToolbarWeekNav,
} from "./OrganiserToolbar";
import { QuickMealModal } from "./QuickMealModal";
import { WeeklyReviewPanel } from "./WeeklyReviewPanel";
import { WeeklyKanbanSurface } from "./WeeklyKanbanSurface";
import type { QuickMealDraft } from "./QuickMealModal";
import type { ReviewEntry } from "./WeeklyReviewPanel";
import {
	WeeklyVisibleType,
	WeeklyVisibleTypeState,
} from "./weekly-organiser-types";
import { slugify } from "@/shared/slugify";
import type { PlannerOrderStore } from "../utils/planner-order";
import { selectWeeklyShoppingRecipePaths } from "../utils/weekly-shopping-selection";
import type {
	PlannerBoardIdentity,
	PlannerLaneIdentity,
} from "@/standalone/planner-transition-evidence";


interface WeeklyOrganiserBoardProps {
	app: App;
	presets: OrganiserPreset[];
	eventsFolder?: string;
	dayNotes?: Record<string, string>;
	onSendShoppingList?: (payload: WeeklyOrganiserShoppingListPayload) => void;
	onSaveDayNote?: (date: string, note: string) => void;
	onOpenFile?: (filePath: string, options: { split: boolean }) => void;
	markedWidth?: number;
	onSaveMarkedWidth?: (width: number) => void;
	onUnmarkRecipe: (path: string) => Promise<void>;
	onLoadImage?: (path: string) => Promise<string | null>;
	onGetLoadedImage?: (path: string) => string | undefined;
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
	startHostWidth: number;
	startWidth: number;
};


const DEFAULT_WEEKLY_VISIBLE_TYPES: WeeklyVisibleTypeState = {
	recipe: true,
	exercise: true,
	task: true,
	reminder: true,
};

function normalizeTypeValues(value: unknown): string[] {
	if (Array.isArray(value)) {
		const normalized: string[] = [];
		for (const entry of value) {
			const next = String(entry).trim().toLowerCase();
			if (next.length > 0) normalized.push(next);
		}
		return normalized;
	}
	const normalized = String(value ?? "").trim().toLowerCase();
	return normalized.length > 0 ? [normalized] : [];
}

function hasReminderType(value: unknown): boolean {
	return normalizeTypeValues(value).includes("reminder");
}

function hasQuickMealFlag(frontmatter: Record<string, unknown>): boolean {
	if (frontmatter.quickMeal === true) return true;
	return String(frontmatter.quickMeal ?? "").trim().toLowerCase() === "true";
}

function normalizeReminderFolder(folderPath?: string): string {
	const normalized = normalizePath(folderPath?.trim() || "events");
	return normalized.length > 0 ? normalized : "events";
}

async function updateScheduledDatesForDrop(
	app: App,
	file: TFile,
	targetColumnId: string,
	options: { sourceColumnId?: string; duplicate?: boolean }
): Promise<void> {
	await app.fileManager.processFrontMatter(
		file,
		(frontmatter) => {
			const nextDates = readScheduledDateList(frontmatter);
			if (
				options.duplicate !== true &&
				options.sourceColumnId &&
				isIsoDateString(options.sourceColumnId) &&
				options.sourceColumnId !== targetColumnId
			) {
				const sourceDate = options.sourceColumnId;
				const sourceIndex = nextDates.indexOf(sourceDate);
				if (sourceIndex !== -1) {
					nextDates.splice(sourceIndex, 1);
				}
			}
			if (!nextDates.includes(targetColumnId)) {
				nextDates.push(targetColumnId);
				nextDates.sort((a, b) => a.localeCompare(b));
			}
			writeScheduledDateList(frontmatter, nextDates);
			delete frontmatter.marked;
		}
	);
}

async function createMarkdownNoteInFolder(
	app: App,
	folderPath: string,
	baseName: string,
	content: string
): Promise<string> {
	const timestamp = Date.now();
	const normalizedFolder = normalizeReminderFolder(folderPath);
	await app.vault.createFolder(normalizedFolder);
	const basePath = normalizePath(`${normalizedFolder}/${baseName}-${timestamp}`);
	let nextPath = `${basePath}.md`;
	let suffix = 1;
	while (app.vault.getAbstractFileByPath(nextPath)) {
		nextPath = `${basePath}-${suffix}.md`;
		suffix += 1;
	}
	await app.vault.create(nextPath, content);
	return nextPath;
}

function parseQuickMealIngredients(input: string): string[] {
	return input
		.split(/\r?\n|,/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function buildQuickMealContent(
	title: string,
	scheduledDate: string,
	ingredients: string[],
	notes: string
): string {
	const ingredientsSection =
		ingredients.length > 0
			? ingredients.map((ingredient) => `- ${ingredient}`).join("\n")
			: "-";
	const notesSection = notes.trim().length > 0 ? `\n## Notes\n\n${notes.trim()}\n` : "";
return `---
title: ${title}
type: recipe
scheduled: ${scheduledDate}
quickMeal: true
---

# ${title}

## Ingredients

${ingredientsSection}

## Method

1. Add steps
${notesSection}
`;
}

function resolveMarkdownFileByPath(app: App, path: string): TFile | null {
	const direct = app.vault.getAbstractFileByPath(path);
	if (direct instanceof TFile) return direct;
	const fallback = app.vault.getMarkdownFiles().find((candidate) => candidate.path === path);
	return fallback ?? null;
}

function runInSequence<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
	return items.reduce((chain, item) => chain.then(() => task(item)), Promise.resolve());
}

function buildQuickMealDraft(scheduledDate: string): QuickMealDraft {
	const defaultTitle = `Quick Meal ${moment(scheduledDate).format("ddd Do MMM")}`;
	return {
		date: scheduledDate,
		title: defaultTitle,
		ingredients: "",
		notes: "",
	};
}

async function createQuickMeal(
	app: App,
	scheduledDate: string,
	input: { title: string; ingredients: string[]; notes: string },
	eventsFolder?: string
): Promise<void> {
	const baseTitle = input.title;
	const slug = slugify(baseTitle, { fallback: "item" });
	await createMarkdownNoteInFolder(
		app,
		eventsFolder || "events",
		`${slug}-${scheduledDate}`,
		buildQuickMealContent(baseTitle, scheduledDate, input.ingredients, input.notes)
	);
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

function groupLabelFn(groupId: string): string {
	switch (groupId) {
		case "recipe":
			return "Recipes";
		case "exercise":
			return "Exercise";
		case "task":
			return "Tasks";
		case "event":
			return "Events";
		case "reminder":
			return "Reminders";
		case "Ungrouped":
			return "Other";
		default:
			return groupId
				.split("-")
				.map((part) =>
					part ? part[0].toUpperCase() + part.slice(1) : ""
				)
				.join(" ");
	}
}

/**
 * Weekly Organiser Board - jKanban + dragula implementation
 * GPU-accelerated drag-and-drop with zero React overhead during drag
 */
// react-doctor-disable-next-line no-giant-component
export const WeeklyOrganiserBoard = React.memo(function WeeklyOrganiserBoard({
	app,
	presets,
	eventsFolder,
	dayNotes,
	onSendShoppingList,
	onSaveDayNote,
	onOpenFile,
	markedWidth = 240,
	onSaveMarkedWidth,
	onUnmarkRecipe,
	onLoadImage,
	onGetLoadedImage,
	plannerOrderStore,
	onBoardReady,
	onBoardError,
}: WeeklyOrganiserBoardProps): React.JSX.Element {
	// The first preset is the caller's declared default; subsequent state changes
	// are deliberate user selection rather than derived prop state.
	// react-doctor-disable-next-line no-derived-useState
	const [activePresetId, setActivePresetId] = React.useState<OrganiserPresetId>(presets[0]?.id);
	const [currentMarkedWidth, setCurrentMarkedWidth] = React.useState(() =>
		normalizeWeeklyColumnMinWidth(markedWidth)
	);
	const [resizerBoundaryPx, setResizerBoundaryPx] = React.useState(() =>
		normalizeWeeklyColumnMinWidth(markedWidth)
	);
	const [resizeSession, setResizeSession] = React.useState<MarkedColumnResizeSession | null>(null);

	React.useEffect(() => {
		setCurrentMarkedWidth(normalizeWeeklyColumnMinWidth(markedWidth));
	}, [markedWidth]);

	const [searchQuery, setSearchQuery] = React.useState("");
	const [activePopover, setActivePopover] = React.useState<
		"filter" | "group" | "sort" | null
	>(null);
	const [weeklyVisibleTypes, setWeeklyVisibleTypes] =
		React.useState<WeeklyVisibleTypeState>(DEFAULT_WEEKLY_VISIBLE_TYPES);
	const [groupBy, setGroupBy] = React.useState("none");
	const [sortBy, setSortBy] = React.useState("default");
	const [showTimeControls, setShowTimeControls] = React.useState(true);
	const [weekOffset, setWeekOffset] = React.useState(0);
	const [isCalendarOpen, setIsCalendarOpen] = React.useState(false);
	const [isReviewOpen, setIsReviewOpen] = React.useState(false);
	const [reviewEntries, setReviewEntries] = React.useState<ReviewEntry[]>([]);
	const [isReviewSaving, setIsReviewSaving] = React.useState(false);
	const [quickMealDraft, setQuickMealDraft] = React.useState<QuickMealDraft | null>(null);
	const [kanbanHeightPx, setKanbanHeightPx] = React.useState<number | null>(null);
	const refreshColumnsRef = React.useRef<((columnIds?: string[]) => void) | null>(null);
	const rebuildBoardRef = React.useRef<(() => void) | null>(null);
	const plannerRootRef = React.useRef<HTMLDivElement>(null);
	const topbarRef = React.useRef<HTMLDivElement>(null);
	const reviewPanelRef = React.useRef<HTMLDivElement>(null);
	const kanbanRef = React.useRef<HTMLDivElement>(null);
	const calendarInputRef = React.useRef<HTMLInputElement>(null);
	const calendarPopoverRef = React.useRef<HTMLDivElement>(null);
	const calendarToggleRef = React.useRef<HTMLButtonElement>(null);
	const filterButtonRef = React.useRef<HTMLButtonElement>(null);
	const filterPopoverRef = React.useRef<HTMLDivElement>(null);
	const groupButtonRef = React.useRef<HTMLButtonElement>(null);
	const groupPopoverRef = React.useRef<HTMLDivElement>(null);
	const sortButtonRef = React.useRef<HTMLButtonElement>(null);
	const sortPopoverRef = React.useRef<HTMLDivElement>(null);

	const lastOpenLeafRef = React.useRef<WorkspaceLeaf | null>(null);

	const activePreset = React.useMemo(
		() => findPresetById(activePresetId),
		[activePresetId]
	);

	const fieldManager = React.useMemo(() => new FieldManager(app), [app]);
	const resolveKanbanImageSrc = React.useCallback(
		(item: OrganiserItem) => resolveCoverImage(app, item),
		[app]
	);

	const syncResizerBoundary = React.useCallback(() => {
		const hostWidth = kanbanRef.current?.clientWidth ?? 0;
		setResizerBoundaryPx(computeWeeklyTrackWidth(hostWidth, currentMarkedWidth));
	}, [currentMarkedWidth]);
	const saveMarkedWidth = React.useEffectEvent((width: number) => {
		onSaveMarkedWidth?.(width);
	});
	const syncResizerBoundaryEvent = React.useEffectEvent(syncResizerBoundary);
	const isResizingMarked = resizeSession !== null;

	React.useEffect(() => {
		syncResizerBoundary();
	}, [syncResizerBoundary]);

	React.useEffect(() => {
		const host = kanbanRef.current;
		if (!host || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => syncResizerBoundary());
		observer.observe(host);
		return () => observer.disconnect();
	}, [syncResizerBoundary]);

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
			startHostWidth,
			startWidth: computeWeeklyTrackWidth(startHostWidth, currentMarkedWidth),
		});
	};

	React.useEffect(() => {
		if (!resizeSession) return;
		const handleMouseMove = (event: MouseEvent) => {
			const diff = event.clientX - resizeSession.startX;
			const nextWidth = normalizeWeeklyColumnMinWidth(resizeSession.startWidth + diff);
			setCurrentMarkedWidth(nextWidth);
			const hostWidth = kanbanRef.current?.clientWidth ?? resizeSession.startHostWidth;
			setResizerBoundaryPx(computeWeeklyTrackWidth(hostWidth, nextWidth));
		};
		const handleMouseUp = (event: MouseEvent) => {
			const diff = event.clientX - resizeSession.startX;
			setResizeSession(null);
			if (Math.abs(diff) < 1) {
				syncResizerBoundaryEvent();
				return;
			}
			const finalWidth = normalizeWeeklyColumnMinWidth(resizeSession.startWidth + diff);
			setCurrentMarkedWidth(finalWidth);
			const hostWidth = kanbanRef.current?.clientWidth ?? resizeSession.startHostWidth;
			setResizerBoundaryPx(computeWeeklyTrackWidth(hostWidth, finalWidth));
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
		() => createWeeklyOrganiserConfig(weekOffset, activePreset, dayNotes),
		[weekOffset, activePreset, dayNotes]
	);

	React.useEffect(() => {
		if (!onLoadImage) return;
		let cancelled = false;
		let timeoutId: number | null = null;
		let idleId: number | null = null;

		const shouldLoadDirectly = (src: string) =>
			!(
				src.startsWith("http://") ||
				src.startsWith("https://") ||
				src.startsWith("blob:") ||
				src.startsWith("data:") ||
				src.startsWith("app:")
			);

		const preload = () => {
			if (cancelled) return;
			const { entriesByFile } = buildBoardEntries(app, config, {
				logPrefix: "WeeklyOrganiser",
				logItemErrors: false,
			});
			const candidates: string[] = [];
			for (const entry of entriesByFile.values()) {
				if (entry.item.type !== "recipe") continue;
				const src = resolveCoverImage(app, entry.item);
				if (!src || !shouldLoadDirectly(src) || onGetLoadedImage?.(src)) continue;
				candidates.push(src);
				if (candidates.length === 12) break;
			}

			for (const src of candidates) {
				void onLoadImage(src).catch(() => {
					// best-effort warmup
				});
			}
		};

		if (typeof (window as any).requestIdleCallback === "function") {
			idleId = (window as any).requestIdleCallback(preload, { timeout: 1200 });
		} else {
			timeoutId = window.setTimeout(preload, 250);
		}

		return () => {
			cancelled = true;
			if (timeoutId !== null) window.clearTimeout(timeoutId);
			if (idleId !== null && typeof (window as any).cancelIdleCallback === "function") {
				(window as any).cancelIdleCallback(idleId);
			}
		};
	}, [app, config, onLoadImage, onGetLoadedImage]);

	const isRecipePreset = React.useMemo(
		() =>
			activePreset.typeFilter.some(
				(value) => value.toLowerCase() === "recipe"
			),
		[activePreset.typeFilter]
	);

	const loadReviewEntries = React.useCallback((): ReviewEntry[] => {
		const { entriesByFile } = buildBoardEntries(app, config, {
			logPrefix: "WeeklyOrganiser",
			logItemErrors: false,
		});

		return Array.from(entriesByFile.values())
			.filter((entry) => entry.item.type === "recipe" && entry.item.date)
			.sort((a, b) =>
				(a.item.date ?? "").localeCompare(b.item.date ?? "")
			)
			.map((entry) => {
				const scheduledDate = entry.item.date ?? "";
				const cookedDate = normalizeReviewDate(entry.item.date);
				const coverUrl = resolveCoverImage(
					app,
					entry.item
				);
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
	}, [app, config]);

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
				itemType?: string;
				itemTitle?: string;
				order?: {
					sourceColumnId?: string;
					targetColumnId: string;
					sourceEntryIds: string[];
					targetEntryIds: string[];
				};
			}
		) => {
			const file = resolveMarkdownFileByPath(app, itemId);
			const targetColumn = config.columns.find(
				(c) => c.id === targetColumnId
			);

			if (file && targetColumn) {
				const frontmatter =
					app.metadataCache.getFileCache(file)?.frontmatter ?? {};
				const duplicateDrop =
					options?.duplicate === true && !targetColumn.isDefault;
				const sourceColumnId = options?.sourceColumnId;
				const droppedType = String(options?.itemType ?? "").toLowerCase();
				const droppedTypeValues = normalizeTypeValues(frontmatter.type);
				const isRecipeDrop =
					droppedType === "recipe" ||
					droppedType === "meal" ||
					droppedTypeValues.includes("recipe") ||
					droppedTypeValues.includes("meal");
				const isReminderDrop =
					droppedType === "reminder" ||
					(hasReminderType(frontmatter.type) && !hasQuickMealFlag(frontmatter));
				if (!duplicateDrop && targetColumn.isDefault && isReminderDrop) {
					await app.vault.trash(file, true);
					return { deleted: true };
				}
				if (
					!duplicateDrop &&
					targetColumn.isDefault &&
					isRecipeDrop &&
					isIsoDateString(sourceColumnId)
				) {
					const removalState: { result: RecipeDateRemovalResult | null } = {
						result: null,
					};
					await app.fileManager.processFrontMatter(
						file,
						(frontmatterUpdate) => {
							removalState.result = removeRecipeScheduledDateOccurrence(
								frontmatterUpdate,
								sourceColumnId
							);
							console.info("planner_drop_recipe_to_marked", {
								filePath: file.path,
								sourceColumnId,
								targetColumnId,
								result: removalState.result,
								refreshColumns: ["marked", sourceColumnId],
							});
						}
					);
					const removalResult = removalState.result;
					const refreshTargets = new Set<string>(["marked", sourceColumnId]);
					if (removalResult) {
						for (const date of removalResult.remainingDates) {
							refreshTargets.add(date);
						}
					}
					refreshColumnsRef.current?.(Array.from(refreshTargets));
					if (removalResult && !removalResult.marked) {
						return { deleted: true };
					}
					return;
				}
				if (isIsoDateString(targetColumnId)) {
					await updateScheduledDatesForDrop(app, file, targetColumnId, {
						sourceColumnId,
						duplicate: duplicateDrop,
					});
					return;
				}
				await fieldManager.updateFieldForColumn(file, targetColumn, config.fieldMapping);
			}
		},
		[app, config, eventsFolder, fieldManager]
	);

	const handleCardClick = React.useCallback(
		(event: MouseEvent, itemId: string, options?: { split: boolean }) => {
			const file = app.vault.getAbstractFileByPath(itemId);
			if (!(file instanceof TFile)) return;

			const isForceSplit = options?.split ?? (event.ctrlKey || event.metaKey);
			if (onOpenFile) {
				onOpenFile(file.path, { split: isForceSplit });
				return;
			}
			const isValidLeaf = (leaf: WorkspaceLeaf | null) => {
				if (!leaf) return false;
				if (leaf.view?.getViewType?.() === "weekly-organiser-view") {
					return false;
				}
				const viewState = leaf.getViewState();
				if (viewState?.pinned) return false;
				return true;
			};
			let leaf: WorkspaceLeaf;
			if (isForceSplit) {
				leaf = app.workspace.getLeaf("split", "vertical");
			} else if (isValidLeaf(lastOpenLeafRef.current)) {
				leaf = lastOpenLeafRef.current as WorkspaceLeaf;
			} else {
				const recentLeaf = app.workspace.getMostRecentLeaf();
				const fallbackLeaf = app.workspace
					.getLeavesOfType("markdown")
					.find((candidate) => isValidLeaf(candidate));
				leaf = isValidLeaf(recentLeaf)
					? (recentLeaf as WorkspaceLeaf)
					: fallbackLeaf ?? app.workspace.getLeaf("split", "vertical");
			}
			lastOpenLeafRef.current = leaf;
			leaf.openFile(file, { active: true });
		},
		[app, onOpenFile]
	);

	const handleRemoveRecipe = React.useCallback(
		async (itemId: string, options?: { sourceColumnId?: string }) => {
			const file = app.vault.getAbstractFileByPath(itemId);
			if (!(file instanceof TFile)) return;
			const cache = app.metadataCache.getFileCache(file);
			const frontmatter = cache?.frontmatter ?? {};
			const typeValues = normalizeTypeValues(frontmatter.type);
			if (!typeValues.includes("recipe") && !typeValues.includes("meal")) return;
			const sourceColumnId = options?.sourceColumnId;

			await removePlannerRecipe(
				sourceColumnId,
				async (date) => {
					await app.fileManager.processFrontMatter(
						file,
						(fm) => {
							const result = removeRecipeScheduledDateOccurrence(fm, date, { markWhenEmpty: false });
							console.info("planner_remove_recipe_date_occurrence", {
								filePath: file.path,
								sourceColumnId: date,
								result,
							});
						}
					);
				},
				() => onUnmarkRecipe(file.path)
			);
		},
		[app, onUnmarkRecipe]
	);

	const deferredSearchQuery = React.useDeferredValue(searchQuery);
	const normalizedSearch = React.useMemo(
		() => deferredSearchQuery.trim().toLowerCase(),
		[deferredSearchQuery]
	);

	const runtimeFilter = React.useCallback(
		(item: OrganiserItem, frontmatter: Record<string, unknown>) => {
			if (activePreset.id === "meal" && item.type === "reminder") {
				return hasQuickMealFlag(frontmatter);
			}
			if (activePreset.id === "weekly") {
				const isVisibleType = weeklyVisibleTypes[item.type as WeeklyVisibleType];
				if (!isVisibleType) return false;
			}
			if (!normalizedSearch) return true;
			return (
				item.title.toLowerCase().includes(normalizedSearch) ||
				item.path.toLowerCase().includes(normalizedSearch)
			);
		},
		[activePreset.id, normalizedSearch, weeklyVisibleTypes]
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

	const groupByFn = React.useMemo(() => {
		if (groupBy === "type") {
			return (item: OrganiserItem) => item.type;
		}
		return undefined;
	}, [groupBy]);

	const groupOrderFn = React.useMemo(() => {
		if (groupBy !== "type") return undefined;
		const orderMap = new Map<string, number>();
		activePreset.typeFilter.forEach((value, index) => {
			orderMap.set(value.toLowerCase(), index);
		});
		return (a: string, b: string) => {
			const aIndex = orderMap.get(a.toLowerCase());
			const bIndex = orderMap.get(b.toLowerCase());
			if (aIndex === undefined && bIndex === undefined) {
				return a.localeCompare(b);
			}
			if (aIndex === undefined) return 1;
			if (bIndex === undefined) return -1;
			return aIndex - bIndex;
		};
	}, [activePreset.typeFilter, groupBy]);

	const groupOptions = React.useMemo(() => {
		const options = [{ id: "none", label: "None" }];
		for (const field of activePreset.fields) {
			if (field.groupable) {
				options.push({ id: field.key, label: field.label });
			}
		}
		return options;
	}, [activePreset.fields]);

	React.useEffect(() => {
		if (!groupOptions.some((option) => option.id === groupBy)) {
			setGroupBy("none");
		}
	}, [groupBy, groupOptions]);

	const isTimeRowVisible = activePreset.isTimeBased && showTimeControls;

	// Week navigation identity is also the authoritative transition evidence scope.
	const startDate = moment()
		.add(weekOffset, "weeks")
		.startOf("isoWeek");
	const endDate = startDate.clone().add(6, "days");
	const weekRangeDisplay = `${startDate.format("MMM Do")} - ${endDate.format("MMM Do, YYYY")}`;
	const startDateValue = startDate.format("YYYY-MM-DD");
	const endDateValue = endDate.format("YYYY-MM-DD");
	const handleBoardReady = React.useCallback((lanes: PlannerLaneIdentity[]) => {
		onBoardReady?.({
			presetId: activePreset.id,
			weekStart: startDateValue,
			weekEnd: endDateValue,
			lanes,
		});
	}, [activePreset.id, endDateValue, onBoardReady, startDateValue]);

	React.useEffect(() => {
		if (!isTimeRowVisible && isCalendarOpen) {
			setIsCalendarOpen(false);
		}
	}, [isCalendarOpen, isTimeRowVisible]);

	// jKanban integration - GPU-accelerated drag-and-drop
	const { containerRef, refreshColumns, rebuild, reflowLayout } = useKanbanBoard<OrganiserItem>({
		app,
		config,
		elementId: "weekly-organiser-kanban",
		onDrop: handleDrop,
		onCardClick: handleCardClick,
		onRemove: handleRemoveRecipe,
		runtimeFilter,
		runtimeSort,
		groupBy: groupByFn,
		groupLabel: groupLabelFn,
		groupOrder: groupOrderFn,
		resolveCardImageSrc: resolveKanbanImageSrc,
		loadCardImageSrc: onLoadImage,
		getLoadedCardImageSrc: onGetLoadedImage,
		logPrefix: "WeeklyOrganiser",
		logItemErrors: true,
		presetTypeFilter: activePreset.typeFilter,
		plannerOrderPresetId: activePreset.id,
		manualOrder: sortBy === "default" && groupBy === "none",
		refreshDelayMs: 50,
		clickBlockMs: 500,
		dragCooldownMs: 300,
		plannerOrderStore,
		onBoardReady: handleBoardReady,
		onBoardError,
	});

	React.useEffect(() => {
		if (kanbanHeightPx === null) return;
		reflowLayout();
	}, [kanbanHeightPx, reflowLayout]);

	React.useEffect(() => {
		refreshColumnsRef.current = refreshColumns;
	}, [refreshColumns]);

	React.useEffect(() => {
		rebuildBoardRef.current = rebuild;
	}, [rebuild]);


	React.useLayoutEffect(() => {
		const rootElement = plannerRootRef.current;
		const topbarElement = topbarRef.current;
		const kanbanElement = kanbanRef.current;
		if (!rootElement || !topbarElement || !kanbanElement) return;
		const root = rootElement;
		const topbar = topbarElement;
		const kanban = kanbanElement;
		const reviewPanel = reviewPanelRef.current;

		function measureKanbanHeight(): void {
			const rootStyles = window.getComputedStyle(root);
			const rootPaddingBottom = Number.parseFloat(rootStyles.paddingBottom || "0") || 0;
			const nextHeight = Math.max(
				240,
				Math.floor(root.clientHeight - kanban.offsetTop - rootPaddingBottom)
			);
			setKanbanHeightPx((previous) =>
				previous !== null && Math.abs(previous - nextHeight) < 1 ? previous : nextHeight
			);
		}

		measureKanbanHeight();
		const observer = new ResizeObserver(() => measureKanbanHeight());
		observer.observe(root);
		observer.observe(topbar);
		if (reviewPanel) {
			observer.observe(reviewPanel);
		}
		const animationFrameId = window.requestAnimationFrame(measureKanbanHeight);
		window.addEventListener("resize", measureKanbanHeight);
		return () => {
			window.cancelAnimationFrame(animationFrameId);
			window.removeEventListener("resize", measureKanbanHeight);
			observer.disconnect();
		};
	}, [isReviewOpen, quickMealDraft]);

	// Refresh when group/sort/filter changes
	React.useEffect(() => {
		refreshColumns();
	}, [
		groupBy,
		sortBy,
		normalizedSearch,
		refreshColumns,
		weeklyVisibleTypes,
	]);

	const handleColumnNoteAction = React.useCallback(
		async (event: React.MouseEvent, date: string) => {
			event.stopPropagation();
			event.preventDefault();

			if (activePreset.id === "meal") {
				setQuickMealDraft(buildQuickMealDraft(date));
				return;
			}

			if (!onSaveDayNote) return;
			const currentNote = dayNotes?.[date] ?? "";
			const newNote = window.prompt("Enter note for this day:", currentNote);

			if (newNote !== null && newNote !== currentNote) {
				onSaveDayNote(date, newNote.trim());
			}
		},
		[activePreset.id, dayNotes, onSaveDayNote]
	);

	const handleQuickMealSubmit = React.useCallback(async () => {
		if (!quickMealDraft) return;
		const title = quickMealDraft.title.trim();
		if (!title) {
			new Notice("Quick meal title is required.");
			return;
		}
		await createQuickMeal(app, quickMealDraft.date, {
			title,
			ingredients: parseQuickMealIngredients(quickMealDraft.ingredients),
			notes: quickMealDraft.notes,
		}, eventsFolder);
		setQuickMealDraft(null);
		refreshColumns([quickMealDraft.date, "marked"]);
	}, [app, eventsFolder, quickMealDraft, refreshColumns]);

	const handleSendShoppingList = React.useCallback(() => {
		if (!onSendShoppingList) return;
		const { entriesByFile } = buildBoardEntries(app, config, {
			logPrefix: "WeeklyOrganiser",
			logItemErrors: false,
		});
		const recipePaths = selectWeeklyShoppingRecipePaths(
			entriesByFile.values(),
			startDateValue,
			endDateValue
		);
		if (recipePaths.length === 0) {
			new Notice("No scheduled recipes found for this week.");
			return;
		}
		onSendShoppingList({
			recipePaths,
			weekLabel: weekRangeDisplay,
			weekOffset,
		});
	}, [
		app,
		config,
		endDateValue,
		onSendShoppingList,
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
			new Notice("No scheduled recipes found for this week.");
			return;
		}

		const logCount = reviewEntries.filter(
			(entry) => entry.include && entry.cookedDate.trim().length > 0
		).length;
		const confirmMessage =
			logCount > 0
				? `Save ${logCount} review${
						logCount === 1 ? "" : "s"
					} and clear scheduled recipes for ${weekRangeDisplay}?`
				: `Clear scheduled recipes for ${weekRangeDisplay}?`;

		if (!confirm(confirmMessage)) return;

		setIsReviewSaving(true);
		try {
			let loggedCount = 0;
			let clearedCount = 0;

			await runInSequence(reviewEntries, async (entry) => {
				if (!entry.include) return;
				const cookedDate = entry.cookedDate.trim();
				if (!cookedDate) return;

				const file = app.vault.getAbstractFileByPath(entry.path);
				if (!(file instanceof TFile)) return;

				const ratingValue = entry.rating ? Number(entry.rating) : null;
				const rating =
					ratingValue !== null && Number.isNaN(ratingValue)
						? null
						: ratingValue;
				const makeAgainValue =
					entry.makeAgain === ""
						? null
						: entry.makeAgain === "yes";

				const logEntry: CookLogEntryInput = {
					cookedDate,
					rating,
					makeAgain: makeAgainValue,
					notes: entry.notes,
				};

				try {
					await appendCookLogEntryToFile(app, file, logEntry);
					loggedCount += 1;
				} catch (error) {
					console.error("Failed to append cook log", {
						path: entry.path,
						error,
					});
				}
			});

			await runInSequence(reviewEntries, async (entry) => {
				const file = app.vault.getAbstractFileByPath(entry.path);
				if (!(file instanceof TFile)) return;
				try {
					await app.fileManager.processFrontMatter(
						file,
						(frontmatter) => {
							delete frontmatter.scheduled;
							delete frontmatter.scheduledDates;
							delete frontmatter.date;
						}
					);
					clearedCount += 1;
				} catch (error) {
					console.error("Failed to clear scheduled date", {
						path: entry.path,
						error,
					});
				}
			});

			new Notice(
				`Logged ${loggedCount} recipe${
					loggedCount === 1 ? "" : "s"
				}, cleared ${clearedCount}.`
			);
			setIsReviewOpen(false);
			setWeekOffset((prev) => prev + 1);
		} catch (error) {
			console.error("Weekly review failed", error);
			new Notice("Weekly review failed. Check console for details.");
		} finally {
			setIsReviewSaving(false);
		}
	}, [app, isReviewSaving, reviewEntries, weekRangeDisplay]);

	const handleCalendarSelect = React.useCallback((date: Date) => {
		if (!date) return;
		const selected = moment(date);
		if (!selected.isValid()) return;
		const offset = selected
			.startOf("isoWeek")
			.diff(moment().startOf("isoWeek"), "weeks");
		setWeekOffset(offset);
		setIsCalendarOpen(false);
	}, []);
	const handleCalendarClose = React.useCallback(() => {
		setIsCalendarOpen(false);
	}, []);
	const calendarSelectedDate = React.useMemo(
		() => moment(startDateValue, "YYYY-MM-DD").toDate(),
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
				group: {
					button: groupButtonRef,
					panel: groupPopoverRef,
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
		(name: "filter" | "group" | "sort") => {
			setActivePopover((prev) => (prev === name ? null : name));
		},
		[]
	);

	const toggleWeeklyType = React.useCallback((type: WeeklyVisibleType) => {
		setWeeklyVisibleTypes((prev) => ({
			...prev,
			[type]: !prev[type],
		}));
	}, []);

	const handleGroupChange = React.useCallback((next: string) => {
		setGroupBy(next);
		setActivePopover(null);
	}, []);

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
			if (event.key !== "Enter" && event.key !== " ") return;
			const target = event.target as HTMLElement | null;
			const noteButton = target?.closest(".organiser-column-note") as HTMLElement | null;
			const date = noteButton?.dataset.date;
			if (!date) return;
			event.preventDefault();
			void handleColumnNoteAction(event as unknown as React.MouseEvent<HTMLDivElement>, date);
		},
		[handleColumnNoteAction]
	);

	const weeklyTypeFilterActive =
		activePreset.id === "weekly" &&
		Object.values(weeklyVisibleTypes).some((isVisible) => !isVisible);
	const isFilterActive =
		(!showTimeControls && activePreset.isTimeBased) || weeklyTypeFilterActive;
	const isGroupActive = groupBy !== "none";
	const isSortActive = sortBy !== "default";

	const calendarControls = React.useMemo<OrganiserToolbarCalendar>(
		() => ({
			isOpen: isCalendarOpen,
			isTimeRowVisible,
			isTimeBasedPreset: activePreset.isTimeBased,
			startDateValue,
			inputRef: calendarInputRef,
			popoverRef: calendarPopoverRef,
			toggleRef: calendarToggleRef,
			onToggle: handleToggleCalendar,
			onGotoToday: gotoToday,
			onClearDate: handleCalendarClear,
		}),
		[
			activePreset.isTimeBased,
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
			groupButtonRef,
			groupPopoverRef,
			sortButtonRef,
			sortPopoverRef,
			activePopover,
			onToggle: togglePopover,
			showTimeControls,
			onToggleShowTimeControls: setShowTimeControls,
			isWeeklyPreset: activePreset.id === "weekly",
			weeklyVisibleTypes,
			onToggleWeeklyType: toggleWeeklyType,
			groupOptions,
			groupBy,
			onGroupChange: handleGroupChange,
			sortOptions: SORT_OPTIONS,
			sortBy,
			onSortChange: handleSortChange,
			isFilterActive,
			isGroupActive,
			isSortActive,
		}),
		[
			activePopover,
			activePreset.id,
			filterButtonRef,
			filterPopoverRef,
			groupButtonRef,
			groupPopoverRef,
			groupBy,
			groupOptions,
			handleGroupChange,
			handleSortChange,
			isFilterActive,
			isGroupActive,
			isSortActive,
			sortBy,
			sortButtonRef,
			sortPopoverRef,
			showTimeControls,
			togglePopover,
			toggleWeeklyType,
			weeklyVisibleTypes,
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
				presets={presets}
				activePresetId={activePresetId}
				onPresetChange={setActivePresetId}
				searchQuery={searchQuery}
				onSearchChange={setSearchQuery}
				calendar={calendarControls}
				weekNav={weekNavControls}
				onSendShoppingList={onSendShoppingList ? handleSendShoppingList : undefined}
				isRecipePreset={isRecipePreset}
				isReviewOpen={isReviewOpen}
				onToggleReview={handleToggleReview}
				popovers={popoverControls}
			/>
			{isReviewOpen && isRecipePreset && (
				<WeeklyReviewPanel
					entries={reviewEntries}
					isSaving={isReviewSaving}
					weekRangeDisplay={weekRangeDisplay}
					panelRef={reviewPanelRef}
					onClose={() => setIsReviewOpen(false)}
					onCompleteWeek={handleCompleteWeek}
					onUpdateEntry={updateReviewEntry}
					onLoadImage={onLoadImage}
					onGetLoadedImage={onGetLoadedImage}
				/>
			)}
			{quickMealDraft && (
				<QuickMealModal
					draft={quickMealDraft}
					onChange={(next) => setQuickMealDraft(next)}
					onCancel={() => setQuickMealDraft(null)}
					onSubmit={handleQuickMealSubmit}
				/>
			)}
			<div
				className="weekly-organiser-kanban"
				role="region"
				aria-label="Weekly organiser board"
				ref={kanbanRef}
				style={{
					position: "relative",
					height: kanbanHeightPx ? `${kanbanHeightPx}px` : undefined,
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
					tabIndex={0}
					style={{ left: `${Math.max(0, Math.round(resizerBoundaryPx) - 12)}px` }}
					onMouseDown={handleResizeStart}
				/>
			</div>
			</div>
	);
});
