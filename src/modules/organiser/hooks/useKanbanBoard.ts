import * as React from "react";
import { App, TFile, TAbstractFile } from "@/platform";
import type { BaseKanbanItem, BoardConfig } from "../types/kanban-config";
import {
	BoardEntry,
	buildBoardEntries,
	resolveBoardEntriesForFile,
} from "../kanban/buildBoardsData";
import { ColumnLookup } from "../utils/field-manager";
import {
	createKanbanDropFailureHandler,
	createKanbanRemoveHandler,
} from "../utils/kanban-mutation-handlers";
import {
	applyPlannerOrder,
	plannerOrderKey,
	PlannerOrderStore,
} from "../utils/planner-order";
import { resolveFilePathFromItemId } from "../utils/item-id";
import {
	createClickGate,
	createDragIntentTracker,
	createModifierKeyHandlers,
	createRefreshScheduler,
	resolveCardSplitOpen,
	resolveCardImagesInDom as loadPendingCardImages,
	resolveDropOutcome,
	type ClickGate,
	type DragIntent,
	type DragIntentTracker,
	type KanbanBoardData,
	type KanbanCardData,
	type RefreshScheduler,
} from "@/kanban-core";
import { createKanbanClient, type KanbanClient } from "@/kanban-component/client";
import { escapeHtml } from "@/shared/html";
import { renderItemHTML } from "../kanban/organiserCardTemplate";
import {
	decorateRenderedLanes,
	laneClassNameFor,
	resolveOrganiserDrop,
	REMOVE_RECIPE_ACTION,
} from "../kanban/dropPolicy";
import type { PlannerLaneIdentity } from "@/standalone/planner-transition-evidence";

const plannerCardTimingIdentifier = (entryId: string): string => `mep:planner-card:${entryId}`;
const plannerCardTitleTimingIdentifier = (entryId: string): string => `mep:planner-card-title:${entryId}`;

interface UseKanbanBoardOptions<T extends BaseKanbanItem> {
	app?: App;
	config: Pick<BoardConfig<T>, "id" | "columns">;
	elementId: string;
	onDrop?: (
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
	) =>
		| Promise<void | { createdItemId?: string; deleted?: boolean }>
		| void
		| { createdItemId?: string; deleted?: boolean };
	onCardClick?: (
		event: MouseEvent,
		itemId: string,
		options?: { split: boolean }
	) => void;
	onRemove?: (
		itemId: string,
		options?: {
			sourceColumnId?: string;
			entryId?: string;
		}
	) => Promise<void> | void;
	runtimeFilter?: (
		item: T,
		frontmatter: Record<string, unknown>
	) => boolean;
	runtimeSort?: (a: T, b: T) => number;
	groupBy?: (
		item: T,
		frontmatter: Record<string, unknown>
	) => string | undefined;
	groupLabel?: (groupId: string) => string;
	groupOrder?: (a: string, b: string) => number;
	resolveCardImageSrc?: (item: T) => string;
	loadCardImageSrc?: (path: string) => Promise<string | null>;
	getLoadedCardImageSrc?: (path: string) => string | undefined;
	logPrefix?: string;
	logItemErrors?: boolean;
	presetTypeFilter?: string[];
	plannerOrderPresetId?: string;
	plannerOrderStore?: PlannerOrderStore;
	manualOrder?: boolean;
	refreshDelayMs?: number;
	clickBlockMs?: number;
	dragCooldownMs?: number;
	onBoardReady?: (lanes: PlannerLaneIdentity[]) => void;
	onBoardError?: (error: unknown) => void;
}

export interface UseKanbanBoardResult {
	containerRef: React.RefObject<HTMLDivElement | null>;
	rebuild: () => void;
	refreshColumns: (columnIds?: string[]) => void;
	reflowLayout: () => void;
}

function debugLog(logPrefix: string, ...args: unknown[]): void {
	if ((window as any).__MEP_KANBAN_DEBUG__ !== true) return;
	console.debug(`[${logPrefix}]`, ...args);
}

export function useKanbanBoard<T extends BaseKanbanItem>(
	options: UseKanbanBoardOptions<T>
): UseKanbanBoardResult {
	const {
		app,
		config,
		elementId,
		onDrop,
		onCardClick,
		onRemove,
		runtimeFilter,
		runtimeSort,
		groupBy,
		groupLabel,
		groupOrder,
		resolveCardImageSrc,
		loadCardImageSrc,
		getLoadedCardImageSrc,
		logPrefix = "KanbanBoard",
		logItemErrors = false,
		presetTypeFilter,
		plannerOrderPresetId = config.id,
		plannerOrderStore: providedPlannerOrderStore,
		manualOrder = true,
		refreshDelayMs = 50,
		clickBlockMs = 500,
		dragCooldownMs = 300,
		onBoardReady,
		onBoardError,
	} = options;
	const [plannerOrderStore] = React.useState<PlannerOrderStore | null>(
		() => providedPlannerOrderStore ?? (app && manualOrder ? new PlannerOrderStore(app) : null)
	);
	const plannerOrderStoreRef = React.useRef(plannerOrderStore);
	React.useEffect(() => {
		if (!plannerOrderStoreRef.current && app && manualOrder) {
			plannerOrderStoreRef.current = new PlannerOrderStore(app);
		}
	}, [app, manualOrder]);

	const containerRef = React.useRef<HTMLDivElement>(null);
	const kanbanClientRef = React.useRef<KanbanClient | null>(null);
	const renderIdRef = React.useRef(0);
	const splitModifierStateRef = React.useRef({
		isPressed: false,
		lastPressedAt: 0,
	});
	const duplicateModifierStateRef = React.useRef({
		isPressed: false,
	});
	const dragIntentTrackerRef = React.useRef<DragIntentTracker | null>(null);
	if (!dragIntentTrackerRef.current) {
		dragIntentTrackerRef.current = createDragIntentTracker({
			isDuplicateModifierPressed: () => duplicateModifierStateRef.current.isPressed,
		});
	}
	const lastLoggedDragIntentRef = React.useRef<DragIntent | null>(null);
	const clickGateRef = React.useRef<ClickGate | null>(null);
	if (!clickGateRef.current) {
		clickGateRef.current = createClickGate({ clickBlockMs, dragCooldownMs });
	}
	const schedulerRef = React.useRef<RefreshScheduler | null>(null);
	// Always-current flush implementation the scheduler calls into, so the
	// scheduler (created once, lazily) never closes over stale
	// buildBoardData/applyColumnLayoutStyles/etc. across re-renders.
	const flushRef = React.useRef<(laneIds: string[]) => void>(() => undefined);
	if (!schedulerRef.current) {
		schedulerRef.current = createRefreshScheduler({
			refreshDelayMs,
			clickGate: clickGateRef.current,
			onFlush: (laneIds) => flushRef.current(laneIds),
		});
	}
	const itemHtmlCacheRef = React.useRef<Map<string, { signature: string; html: string }>>(
		new Map()
	);

	// Data refs
	const entriesByItemIdRef = React.useRef<Map<string, BoardEntry<T>>>(new Map());
	const entryIdsByFilePathRef = React.useRef<Map<string, Set<string>>>(new Map());
	const entriesByColumnRef = React.useRef<Map<string, BoardEntry<T>[]>>(new Map());
	const columnLookupRef = React.useRef<ColumnLookup | null>(null);
	const renderedLanesRef = React.useRef<Map<string, string[]>>(new Map());
	const onBoardReadyRef = React.useRef(onBoardReady);
	onBoardReadyRef.current = onBoardReady;
	const onBoardErrorRef = React.useRef(onBoardError);
	onBoardErrorRef.current = onBoardError;
	const layoutResizeObserverRef = React.useRef<ResizeObserver | null>(null);
	const refreshColumnsRef = React.useRef<((columnIds?: string[]) => void) | null>(null);

	const optionsRef = React.useRef({
		runtimeFilter,
		runtimeSort,
		groupBy,
		groupLabel,
		groupOrder,
		resolveCardImageSrc,
		loadCardImageSrc,
		getLoadedCardImageSrc,
	});
	React.useEffect(() => {
		optionsRef.current = {
			runtimeFilter,
			runtimeSort,
			groupBy,
			groupLabel,
			groupOrder,
			resolveCardImageSrc,
			loadCardImageSrc,
			getLoadedCardImageSrc,
		};
	}, [
		getLoadedCardImageSrc,
		groupBy,
		groupLabel,
		groupOrder,
		loadCardImageSrc,
		resolveCardImageSrc,
		runtimeFilter,
		runtimeSort,
	]);

	const destroyKanban = React.useCallback(() => {
		kanbanClientRef.current?.destroy();
		kanbanClientRef.current = null;
	}, []);

	const resolveDragIntentAtStart = React.useCallback((el: HTMLElement): DragIntent | null => {
		const itemId = el?.dataset?.eid;
		if (!itemId) return null;
		const sourceColumnId =
			el.closest(".kanban-board")?.getAttribute("data-id") ?? undefined;
		const intent = dragIntentTrackerRef.current!.resolveAtStart({
			cardId: itemId,
			sourceLaneId: sourceColumnId,
			isTemplate: false,
		});
		if (lastLoggedDragIntentRef.current !== intent) {
			lastLoggedDragIntentRef.current = intent;
			debugLog(logPrefix, "drag:intent", {
				itemId: intent.cardId,
				sourceColumnId: intent.sourceLaneId,
				duplicate: intent.duplicate,
				isTemplate: intent.isTemplate,
				shiftPressed: duplicateModifierStateRef.current.isPressed,
			});
		}
		return intent;
	}, [logPrefix]);

	const resolveCardImagesInDom = React.useCallback((root?: ParentNode) => {
		const container = root ?? containerRef.current;
		const loader = optionsRef.current.loadCardImageSrc;
		if (!container || !loader) return;

		loadPendingCardImages(container, {
			loadCardImage: loader,
			onImageUnavailable: (img) => {
				img.closest(".card-cover")?.classList.add("card-cover--unavailable");
			},
			onImageLoadError: (error, rawPath) => {
				debugLog(logPrefix, "image:load:failed", { rawPath, error });
			},
		});
	}, [logPrefix]);

	const applyColumnLayoutStyles = React.useCallback(
		(kanban: KanbanClient, columnIds?: string[]) => {
			const targetColumns = columnIds ? new Set(columnIds) : null;
			for (const column of config.columns) {
				if (targetColumns && !targetColumns.has(column.id)) continue;
				const boardElement = kanban.lane(column.id);
				if (!boardElement) continue;
				if (column.className) {
					boardElement.classList.add(column.className);
				}
				if (column.gridRow) {
					boardElement.style.gridRow = column.gridRow;
				} else {
					boardElement.style.removeProperty("grid-row");
				}
				if (column.gridColumn) {
					boardElement.style.gridColumn = column.gridColumn;
				} else {
					boardElement.style.removeProperty("grid-column");
				}
				boardElement.style.removeProperty("height");
				boardElement.style.removeProperty("min-height");
			}
		},
		[config.columns]
	);

	// Post-render decoration resolves lane elements for the given ids (or every configured
	// column when omitted) and hands them to the organiser's own decorator
	// (currently just recipe-density classing). Used as the patcher's
	// onLanesRendered callback (fires after every patch flush) and called
	// directly after the initial build and after a drop's DOM mutation.
	const notifyLanesRendered = React.useCallback(
		(laneIds?: string[]) => {
			const kanban = kanbanClientRef.current;
			if (!kanban) return;
			const ids = laneIds ?? config.columns.map((column) => column.id);
			const elements = new Map<string, HTMLElement>();
			for (const id of ids) {
				const boardElement = kanban.lane(id);
				if (boardElement) elements.set(id, boardElement);
			}
			decorateRenderedLanes(elements, ids);
			for (const element of elements.values()) resolveCardImagesInDom(element);
		},
		[config.columns, resolveCardImagesInDom]
	);

	// Build board data from entries
	const buildBoardData = React.useCallback(
		(columnIds?: string[]): KanbanBoardData[] => {
			const boards: KanbanBoardData[] = [];
			const targetColumns = columnIds ? new Set(columnIds) : null;
			const columnsToProcess = targetColumns
				? config.columns.filter((column) => targetColumns.has(column.id))
				: config.columns;

			for (const column of columnsToProcess) {
				const entries = applyPlannerOrder(
					entriesByColumnRef.current.get(column.id) ?? [],
					manualOrder
						? plannerOrderStoreRef.current?.get(config.id, plannerOrderPresetId, column.id)
						: undefined
				);
				const opts = optionsRef.current;

				// Apply filter
				const filtered = opts.runtimeFilter
					? entries.filter(({ item, frontmatter }) =>
							opts.runtimeFilter!(item, frontmatter)
						)
					: entries;

				// Apply sort
				const sorted = opts.runtimeSort
					? [...filtered].sort((a, b) => opts.runtimeSort!(a.item, b.item))
					: filtered;

				const cards: KanbanCardData[] = [];

				if (opts.groupBy) {
					// Group items
					const grouped = new Map<string, BoardEntry<T>[]>();
					for (const entry of sorted) {
						const rawGroup = opts.groupBy(entry.item, entry.frontmatter);
						const gid = rawGroup && rawGroup.trim().length > 0 ? rawGroup : "Ungrouped";
						const bucket = grouped.get(gid);
						if (bucket) {
							bucket.push(entry);
						} else {
							grouped.set(gid, [entry]);
						}
					}

					const groupIds = Array.from(grouped.keys());
					if (opts.groupOrder) {
						groupIds.sort(opts.groupOrder);
					} else {
						groupIds.sort((a, b) => a.localeCompare(b));
					}

					for (const gid of groupIds) {
						const label = opts.groupLabel ? opts.groupLabel(gid) : gid;
						cards.push({
							id: `__group:${column.id}:${gid}`,
							html: `<div class="kanban-group-label">${escapeHtml(label)}</div>`,
							classes: ["kanban-group-header", "not-draggable"],
						});
						for (const entry of grouped.get(gid) ?? []) {
							cards.push(createKanbanItem(entry));
						}
					}
				} else {
					// No grouping
					for (const entry of sorted) {
						cards.push(createKanbanItem(entry));
					}
				}

				boards.push({
					id: column.id,
					titleHtml: column.title,
					cards,
					headerClasses: [laneClassNameFor(column.id)].filter(Boolean),
				});
			}

			return boards;
		},
		[config.columns, config.id, manualOrder, plannerOrderPresetId]
	);

	const createKanbanItem = (entry: BoardEntry<T>): KanbanCardData => {
		const classes: string[] = [];
		if (entry.item.type === "recipe") {
			classes.push("organiser-card--recipe-card");
		}
		const resolvedCoverImage = optionsRef.current.resolveCardImageSrc?.(entry.item);
		const signature = [
			entry.item.title,
			entry.item.type ?? "",
			resolvedCoverImage ?? entry.item.coverImage ?? "",
		].join("|");
		const cached = itemHtmlCacheRef.current.get(entry.filePath);
		let titleHtml: string;
		if (cached && cached.signature === signature) {
			titleHtml = cached.html;
		} else {
			titleHtml = renderItemHTML(
				entry.item,
				resolvedCoverImage,
				optionsRef.current.getLoadedCardImageSrc
			);
			itemHtmlCacheRef.current.set(entry.filePath, { signature, html: titleHtml });
		}
		const instrumentedTitleHtml = titleHtml.replace(
			'class="card-title"',
			`class="card-title" elementtiming="${escapeHtml(plannerCardTitleTimingIdentifier(entry.entryId))}"`
		);
		return {
			id: entry.entryId,
			html: instrumentedTitleHtml,
			classes,
			elementTimingIdentifier: plannerCardTimingIdentifier(entry.entryId),
		};
	};

	const handleCardMouseDown = React.useCallback((event: MouseEvent, cardId: string) => {
		const item = (event.target as HTMLElement).closest<HTMLElement>(".kanban-item");
		if (!item || item.classList.contains("kanban-group-header") || item.classList.contains("kanban-static-item")) return;
		const split = event.ctrlKey || event.metaKey;
		if (split) splitModifierStateRef.current.lastPressedAt = Date.now();
		clickGateRef.current!.captureClickIntent({ cardId, split });
		debugLog(logPrefix, "click:intent", { cardId, split });
	}, [logPrefix]);

	const handleCardClick = React.useCallback((event: MouseEvent, cardId: string) => {
		if (!onCardClick || clickGateRef.current!.shouldSuppressClick()) return;
		const target = event.target as HTMLElement;
		const item = target.closest<HTMLElement>(".kanban-item");
		if (!item || item.classList.contains("kanban-group-header") || item.classList.contains("kanban-static-item")) return;
		const filePath = resolveFilePathFromItemId(cardId, entriesByItemIdRef.current.get(cardId)?.filePath);
		const now = Date.now();
		const clickIntent = clickGateRef.current!.clickIntent();
		const split = resolveCardSplitOpen({ cardId, eventSplit: event.ctrlKey || event.metaKey, now, clickIntent, modifierState: splitModifierStateRef.current });
		debugLog(logPrefix, "click:open", { cardId, filePath, split, hasFreshIntent: clickIntent?.cardId === cardId && now - clickIntent.at < 1200 });
		onCardClick(event, filePath, { split });
	}, [logPrefix, onCardClick]);

	// Core's onAction delegation (data-kanban-action): the only action name
	// the organiser module wires up today is the recipe-remove button
	// (REMOVE_RECIPE_ACTION, from ../kanban/dropPolicy) handles that action.
	const handleCardAction = React.useCallback((name: string, cardId: string, event: MouseEvent) => {
		if (name !== REMOVE_RECIPE_ACTION || !onRemove) return;
		event.stopPropagation();
		const target = event.target as HTMLElement;
		const item = target.closest<HTMLElement>(".kanban-item");
		const filePath = resolveFilePathFromItemId(cardId, entriesByItemIdRef.current.get(cardId)?.filePath);
		const sourceColumnId = item?.closest(".kanban-board")?.getAttribute("data-id") ?? entriesByItemIdRef.current.get(cardId)?.columnId;
		void createKanbanRemoveHandler(onRemove, logPrefix)(filePath, { sourceColumnId: sourceColumnId ?? undefined, entryId: cardId });
	}, [logPrefix, onRemove]);

	const publishBoardReady = React.useCallback(() => {
		onBoardReadyRef.current?.(config.columns.map((column) => ({
			id: column.id,
			cardIds: [...(renderedLanesRef.current.get(column.id) ?? [])],
		})));
	}, [config.columns]);

	// Initialize jKanban
	const initKanban = React.useCallback(() => {
		if (!containerRef.current) return;

		const renderId = ++renderIdRef.current;
		if (renderIdRef.current !== renderId || !containerRef.current) return;

		const element = containerRef.current;
			destroyKanban();
			element.innerHTML = "";

			try {
				if (renderIdRef.current !== renderId) return;
				const boards = buildBoardData();
				renderedLanesRef.current = new Map(
					boards.map((board) => [board.id, board.cards.map((card) => card.id)])
				);
				const reportDropFailure = (
					error: unknown,
					sourceColumnId: string | undefined,
					targetColumnId: string
				) => {
					createKanbanDropFailureHandler(
						sourceColumnId,
						targetColumnId,
						(columnIds) => refreshColumnsRef.current?.(columnIds),
						logPrefix
					)(error);
				};
				debugLog(logPrefix, "Initializing jKanban", {
					elementId,
					boardCount: boards.length,
					itemCount: boards.reduce((sum, board) => sum + board.cards.length, 0),
				});

				const kanban = createKanbanClient({
					element,
					boards,
					callbacks: {
				copyItem: (el: HTMLElement) => {
					const intent = resolveDragIntentAtStart(el);
					if (!intent) return false;
					debugLog(logPrefix, "drag:copy:decision", {
						itemId: intent.cardId,
						shouldCopy: intent.duplicate,
						shiftPressed: duplicateModifierStateRef.current.isPressed,
						sourceColumnId: intent.sourceLaneId,
					});
					return intent.duplicate;
				},
					dragEl: (el: HTMLElement) => {
						if (
							el.classList.contains("kanban-group-header") ||
							el.classList.contains("kanban-static-item")
						) {
							return;
						}
						const dragIntent = resolveDragIntentAtStart(el);
						clickGateRef.current!.dragStarted();
						el.classList.add("is-dragging");
						element.classList.add("is-board-dragging");
					debugLog(logPrefix, "drag:start", {
						itemId: el.dataset.eid,
						duplicate: dragIntent?.duplicate,
						sourceColumnId: dragIntent?.sourceLaneId,
					});
				},
					dragendEl: (el: HTMLElement) => {
					if (
						el.classList.contains("kanban-group-header") ||
						el.classList.contains("kanban-static-item")
					) {
						return;
					}
						el.classList.remove("is-dragging");
						element.classList.remove("is-board-dragging");
						clickGateRef.current!.dragEnded();
						dragIntentTrackerRef.current!.clear();
						debugLog(logPrefix, "drag:end", { itemId: el.dataset.eid });
					},
					onDrop: (move) => {
					const { cardId, sourceLaneId, targetLaneId } = move;
					const el = move.element;
					if (
						el.classList.contains("kanban-group-header") ||
						el.classList.contains("kanban-static-item")
					) {
						return;
					}
					const dragIntent = dragIntentTrackerRef.current!.active();
					const syncRecipeDensityForChangedBoards = () => {
						const changedBoards = [sourceLaneId, targetLaneId].filter(
							(value): value is string => Boolean(value)
						);
						notifyLanesRendered(changedBoards.length > 0 ? changedBoards : undefined);
					};
					debugLog(logPrefix, "drag:drop", {
						cardId,
						sourceLaneId,
						targetLaneId,
						intent: dragIntent,
					});

					if (cardId && targetLaneId) {
						const idsForColumn = (columnId: string, includeId?: string, knownOnly = false): string[] => {
							const board = element.querySelector(`[data-id="${CSS.escape(columnId)}"]`);
							if (!board) return includeId ? [includeId] : [];
							const knownIds = entriesByItemIdRef.current;
							const ids: string[] = [];
							for (const candidate of board.querySelectorAll<HTMLElement>(".kanban-drag > .kanban-item")) {
								const id = candidate.dataset.eid;
								if (!id || (knownOnly && id !== includeId && !knownIds.has(id))) continue;
								ids.push(id);
							}
							return Array.from(new Set(ids));
						};
						const internalDrop = onDrop;
						if (!internalDrop) return;
						const intentForDrop =
							dragIntent && dragIntent.cardId === cardId ? dragIntent : null;
							if (!intentForDrop) {
								debugLog(logPrefix, "drag:drop:ignored", {
									reason: "missing-drag-intent",
									cardId,
									targetLaneId,
								});
								return;
							}
								const entry = entriesByItemIdRef.current.get(cardId);
								const filePath = resolveFilePathFromItemId(cardId, entry?.filePath);
								const nextEntryId = `${filePath}::${targetLaneId}`;
								// The organiser's marked-column/reminder policy
								// decides move/copy/remove; this handler only carries
								// out the DOM/persistence mechanics for whichever
								// outcome comes back.
								const outcome = resolveDropOutcome(
									{
										cardId,
										sourceLaneId: intentForDrop.sourceLaneId ?? sourceLaneId,
										targetLaneId,
										isTemplate: false,
										duplicateModifier: intentForDrop.duplicate,
										cardType: entry?.item.type,
									},
									resolveOrganiserDrop
								);

								if (outcome === "reject") {
									el.remove();
									syncRecipeDensityForChangedBoards();
									return;
								}

								const shouldDuplicate = outcome === "copy";
								if (
									shouldDuplicate &&
									entriesByItemIdRef.current.has(nextEntryId)
								) {
									el.remove();
									syncRecipeDensityForChangedBoards();
									return;
								}
							if (outcome === "remove") {
								el.remove();
								syncRecipeDensityForChangedBoards();
							} else {
								if (kanbanClientRef.current) kanbanClientRef.current.rekeyCard(el, nextEntryId);
								else el.dataset.eid = nextEntryId;
								el.setAttribute("elementtiming", plannerCardTimingIdentifier(nextEntryId));
								syncRecipeDensityForChangedBoards();
							}
							const order = {
								sourceColumnId: intentForDrop.sourceLaneId ?? sourceLaneId ?? undefined,
								targetColumnId: targetLaneId,
								sourceEntryIds: idsForColumn(intentForDrop.sourceLaneId ?? sourceLaneId ?? "", undefined, true),
								targetEntryIds: idsForColumn(targetLaneId, nextEntryId, true),
							};
							const dropCommitStartedAt =
								typeof performance !== "undefined" ? performance.now() : Date.now();
							Promise.resolve().then(() =>
								internalDrop(filePath, targetLaneId, {
									sourceColumnId: intentForDrop.sourceLaneId,
									duplicate: shouldDuplicate,
									itemType: entry?.item.type ?? "",
									itemTitle: entry?.item.title ?? "",
									order,
								})
							)
								.then(async (dropResult) => {
					if (dropResult?.deleted === true && el.isConnected) {
						el.remove();
						order.targetEntryIds = idsForColumn(targetLaneId, undefined, true);
						syncRecipeDensityForChangedBoards();
					}
									const dropCommitEndedAt =
									typeof performance !== "undefined"
										? performance.now()
										: Date.now();
									debugLog(logPrefix, "drag:drop:commit", {
										cardId: filePath,
										targetLaneId,
										sourceLaneId: intentForDrop.sourceLaneId,
										duplicate: shouldDuplicate,
										ms: Number((dropCommitEndedAt - dropCommitStartedAt).toFixed(1)),
									});
									if (manualOrder && plannerOrderStoreRef.current) {
										const store = plannerOrderStoreRef.current;
										const updates = new Map<string, string[]>();
										if (order.sourceColumnId) updates.set(order.sourceColumnId, order.sourceEntryIds);
										updates.set(order.targetColumnId, order.targetEntryIds);
									const scopedUpdates = new Map(
											Array.from(updates, ([columnId, ids]) => [
												plannerOrderKey(config.id, plannerOrderPresetId, columnId),
												ids,
											] as const)
										);
										await store.replaceMany(scopedUpdates);
										refreshColumnsRef.current?.(Array.from(updates.keys()));
									}
								})
							.catch((err) => {
								reportDropFailure(
									err,
									intentForDrop.sourceLaneId ?? sourceLaneId ?? undefined,
									targetLaneId
								);
							});
					} else {
							debugLog(logPrefix, "drag:drop:ignored", {
							reason: "missing-item-or-target",
							cardId,
							targetLaneId,
						});
					}
				},
					onDropError: (error, move) => {
						reportDropFailure(error, move.sourceLaneId, move.targetLaneId);
					},
					onCardMouseDown: handleCardMouseDown,
					onCardClick: handleCardClick,
					onAction: handleCardAction,
					},
					presentation: { gutter: "0px", widthBoard: "100%" },
					onLanesRendered: (laneIds, elements) => {
						decorateRenderedLanes(elements, laneIds);
						for (const laneElement of elements.values()) resolveCardImagesInDom(laneElement);
						publishBoardReady();
					},
				});

			kanbanClientRef.current = kanban;
			applyColumnLayoutStyles(kanban);
			notifyLanesRendered();

			if (layoutResizeObserverRef.current) {
				layoutResizeObserverRef.current.disconnect();
			}
			const container = containerRef.current;
			if (container) {
				const observer = new ResizeObserver((entries) => {
					debugLog(logPrefix, "layout:resize", {
						hostWidth: entries[0]?.contentRect?.width,
					});
					applyColumnLayoutStyles(kanban);
				});
				observer.observe(container);
				layoutResizeObserverRef.current = observer;
			}
		} catch (error) {
			console.error(`[${logPrefix}] Error initializing jKanban:`, error);
			onBoardErrorRef.current?.(error);
		}
	}, [
		buildBoardData,
		onDrop,
		logPrefix,
		applyColumnLayoutStyles,
			notifyLanesRendered,
			config.id,
			elementId,
			publishBoardReady,
			resolveDragIntentAtStart,
			handleCardMouseDown,
			handleCardClick,
			handleCardAction,
			destroyKanban,
			manualOrder,
			plannerOrderPresetId,
	]);

	// Rebuild from scratch
	const rebuild = React.useCallback(() => {
		try {
			if (!app) throw new Error("Kanban board requires an app");
			// Rebuild data
			const {
				entriesByColumn,
				entriesByItemId,
				entryIdsByFilePath,
				columnLookup,
			} = buildBoardEntries(
				app,
				config as BoardConfig<T>,
				{
					logPrefix,
					logItemErrors,
					presetTypeFilter,
					plannerOrderStore: plannerOrderStoreRef.current ?? undefined,
					plannerOrderPresetId,
					manualOrder,
				}
			);

			entriesByColumnRef.current = entriesByColumn;
			entriesByItemIdRef.current = entriesByItemId;
			entryIdsByFilePathRef.current = entryIdsByFilePath;
			columnLookupRef.current = columnLookup;
			itemHtmlCacheRef.current.clear();

			// Reinitialize jKanban; the patcher is reseeded from the freshly
			// built DOM inside initKanban (snapshotFromDom), so no separate
			// snapshot/signature reset is needed here.
			initKanban();
		} catch (error) {
			console.error(`[${logPrefix}] Error rebuilding kanban board:`, error);
			onBoardErrorRef.current?.(error);
		}
	}, [
		app,
		config,
		logPrefix,
		logItemErrors,
		presetTypeFilter,
		plannerOrderPresetId,
		manualOrder,
		initKanban,
	]);

	// The scheduler owns pending-lane batching, the refresh timer, and
	// drag-cooldown deferral; this flush implementation is what it calls once
	// it decides a batch is due. Assigned every render (not in a useEffect)
	// so it is always current — see flushRef's declaration above.
	flushRef.current = (laneIds: string[]) => {
		const refreshStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
		const boards = buildBoardData(laneIds);
		const kanban = kanbanClientRef.current;
		if (!kanban) return;
		for (const board of boards) {
			renderedLanesRef.current.set(board.id, board.cards.map((card) => card.id));
		}

		const changedLaneIds = kanban.patchLanes(boards);
		applyColumnLayoutStyles(kanban, changedLaneIds);
		const refreshEndedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
		debugLog(logPrefix, "refresh:applied", {
			columns: laneIds,
			boardCount: boards.length,
			ms: Number((refreshEndedAt - refreshStartedAt).toFixed(1)),
		});
	};

	// Refresh specific columns
	const refreshColumns = React.useCallback(
		(columnIds?: string[]) => {
			// Explicitly queue all columns only when caller passes no column ids;
			// the scheduler itself is lane-list agnostic.
			const laneIds = columnIds === undefined ? config.columns.map((column) => column.id) : columnIds;
			debugLog(logPrefix, "refresh:requested", { columns: laneIds });
			schedulerRef.current?.request(laneIds);
		},
		[config.columns, logPrefix]
	);
	React.useEffect(() => {
		refreshColumnsRef.current = refreshColumns;
	}, [refreshColumns]);

	// Set up file watchers
	// react-doctor-disable-next-line effect-needs-cleanup
	React.useEffect(() => {
		if (!app) return;
		const removeEntryByPath = (filePath: string): Set<string> => {
			const entriesByItemId = entriesByItemIdRef.current;
			const entryIdsByFilePath = entryIdsByFilePathRef.current;
			const entriesByColumn = entriesByColumnRef.current;
			const affectedColumns = new Set<string>();
			const entryIds = entryIdsByFilePath.get(filePath);

			if (!entryIds || entryIds.size === 0) {
				itemHtmlCacheRef.current.delete(filePath);
				return affectedColumns;
			}

			for (const entryId of entryIds) {
				const existingEntry = entriesByItemId.get(entryId);
				if (!existingEntry) continue;
				const columnEntries = entriesByColumn.get(existingEntry.columnId);
				if (columnEntries) {
					const index = columnEntries.findIndex((e) => e.entryId === entryId);
					if (index !== -1) {
						columnEntries.splice(index, 1);
					}
				}
				entriesByItemId.delete(entryId);
				affectedColumns.add(existingEntry.columnId);
			}

			entryIdsByFilePath.delete(filePath);
			itemHtmlCacheRef.current.delete(filePath);
			return affectedColumns;
		};

		const updateEntryForFile = (file: TFile): Set<string> => {
			const columnLookup = columnLookupRef.current;
			const entriesByItemId = entriesByItemIdRef.current;
			const entryIdsByFilePath = entryIdsByFilePathRef.current;
			const entriesByColumn = entriesByColumnRef.current;
			const affectedColumns = new Set<string>();

			if (!columnLookup) return affectedColumns;

			const nextEntries = resolveBoardEntriesForFile<T>(
				app,
				file,
				config as BoardConfig<T>,
				columnLookup,
				{ logPrefix, logItemErrors, presetTypeFilter }
			);
			const existingEntryIds = Array.from(
				entryIdsByFilePath.get(file.path) ?? new Set<string>()
			);
			const nextEntryIdSet = new Set(nextEntries.map((entry) => entry.entryId));
			const membershipUnchanged =
				existingEntryIds.length === nextEntries.length &&
				existingEntryIds.every((entryId) => nextEntryIdSet.has(entryId));

			if (membershipUnchanged) {
				for (const nextEntry of nextEntries) {
					const previousEntry = entriesByItemId.get(nextEntry.entryId);
					if (!previousEntry) continue;
					const columnEntries = entriesByColumn.get(previousEntry.columnId);
					const index = columnEntries?.findIndex((entry) => entry.entryId === nextEntry.entryId) ?? -1;
					if (columnEntries && index >= 0) columnEntries[index] = nextEntry;
					entriesByItemId.set(nextEntry.entryId, nextEntry);
					affectedColumns.add(nextEntry.columnId);
				}
				return affectedColumns;
			}

			for (const entryId of existingEntryIds) {
				const previousEntry = entriesByItemId.get(entryId);
				if (!previousEntry) continue;
				const previousColumn = entriesByColumn.get(previousEntry.columnId);
				if (previousColumn) {
					const index = previousColumn.findIndex((candidate) => candidate.entryId === entryId);
					if (index !== -1) {
						previousColumn.splice(index, 1);
					}
				}
				entriesByItemId.delete(entryId);
				affectedColumns.add(previousEntry.columnId);
			}

			if (nextEntries.length === 0) {
				entryIdsByFilePath.delete(file.path);
				itemHtmlCacheRef.current.delete(file.path);
				return affectedColumns;
			}

			const nextEntryIds = new Set<string>();
			for (const nextEntry of nextEntries) {
				const nextColumn = entriesByColumn.get(nextEntry.columnId) ?? [];
				if (!entriesByColumn.has(nextEntry.columnId)) {
					entriesByColumn.set(nextEntry.columnId, nextColumn);
				}
				nextColumn.push(nextEntry);
				entriesByItemId.set(nextEntry.entryId, nextEntry);
				nextEntryIds.add(nextEntry.entryId);
				affectedColumns.add(nextEntry.columnId);
			}
			entryIdsByFilePath.set(file.path, nextEntryIds);

			return affectedColumns;
		};

		const reconcileOrder = (affected: Set<string>) => {
			if (!manualOrder || !plannerOrderStoreRef.current || affected.size === 0) return;
			const updates = new Map<string, string[]>();
			for (const columnId of affected) {
				const ordered = applyPlannerOrder(
					entriesByColumnRef.current.get(columnId) ?? [],
					plannerOrderStoreRef.current.get(config.id, plannerOrderPresetId, columnId)
				);
				updates.set(plannerOrderKey(config.id, plannerOrderPresetId, columnId), ordered.map((entry) => entry.entryId));
			}
			void plannerOrderStoreRef.current.reconcileMany(updates).catch((error) => {
				console.warn(`[${logPrefix}] Failed to reconcile planner order`, error);
			});
		};

		const handleMetadataChange = (file: TAbstractFile | string) => {
			if (!(file instanceof TFile)) return;
			const affected = updateEntryForFile(file);
			reconcileOrder(affected);
			scheduleRefresh(affected);
		};

		const scheduleRefresh = (affectedColumns: Set<string>) => {
			if (affectedColumns.size === 0) return;
			refreshColumns(Array.from(affectedColumns));
		};

		const handleCreate = (file: TAbstractFile) => {
			if (!(file instanceof TFile)) return;
			const affected = updateEntryForFile(file);
			reconcileOrder(affected);
			scheduleRefresh(affected);
		};

		const handleDelete = (file: TAbstractFile) => {
			if (!(file instanceof TFile)) return;
			const affected = removeEntryByPath(file.path);
			reconcileOrder(affected);
			scheduleRefresh(affected);
		};

		const handleRename = (file: TAbstractFile, oldPath: string) => {
			if (!(file instanceof TFile)) return;
			const affected = new Set<string>();
			const removed = removeEntryByPath(oldPath);
			for (const id of removed) affected.add(id);
			const added = updateEntryForFile(file);
			for (const id of added) affected.add(id);
			reconcileOrder(affected);
			scheduleRefresh(affected);
		};

		const metadataRef = app.metadataCache.on("changed", handleMetadataChange);
		const createRef = app.vault.on("create", handleCreate);
		const deleteRef = app.vault.on("delete", handleDelete);
		const renameRef = app.vault.on("rename", handleRename);

		return () => {
			app.metadataCache.offref(metadataRef);
			app.vault.offref(createRef);
			app.vault.offref(deleteRef);
			app.vault.offref(renameRef);
			schedulerRef.current?.cancel();
		};
	}, [
		app,
		config,
		logPrefix,
		logItemErrors,
		presetTypeFilter,
		plannerOrderPresetId,
		manualOrder,
		refreshColumns,
	]);

	// Build synchronously before the first paint when authoritative order is already loaded.
	// The async branch remains completion-owned for other hosts that have not preloaded it.
	React.useLayoutEffect(() => {
		let active = true;
		const plannerOrderStore = plannerOrderStoreRef.current;
		if (plannerOrderStore && !plannerOrderStore.isLoaded()) {
			void plannerOrderStore.load().finally(() => {
				if (active) rebuild();
			});
		} else {
			rebuild();
		}
		return () => {
			active = false;
			if (layoutResizeObserverRef.current) {
				layoutResizeObserverRef.current.disconnect();
				layoutResizeObserverRef.current = null;
			}
			destroyKanban();
		};
	}, [rebuild, destroyKanban]);

	React.useEffect(() => {
		const updateDuplicateModifierState = (isPressed: boolean) => {
			duplicateModifierStateRef.current.isPressed = isPressed;
		};
		const modifierHandlers = createModifierKeyHandlers(updateDuplicateModifierState, ["Shift"]);

		const handleMouseDownCapture = (event: MouseEvent) => {
			const container = containerRef.current;
			const target = event.target as Node | null;
			if (!container || !target) return;
			if (!container.contains(target)) return;
			updateDuplicateModifierState(event.shiftKey);
		};

		modifierHandlers.attach();
		window.addEventListener("mousedown", handleMouseDownCapture, true);
		return () => {
			modifierHandlers.detach();
			window.removeEventListener("mousedown", handleMouseDownCapture, true);
		};
	}, []);

	React.useEffect(() => {
		const handlers = createModifierKeyHandlers((isPressed) => {
			splitModifierStateRef.current.isPressed = isPressed;
			if (isPressed) splitModifierStateRef.current.lastPressedAt = Date.now();
		}, ["Control", "Meta"]);
		handlers.attach();
		return handlers.detach;
	}, []);

	const reflowLayout = React.useCallback(() => {
		const kanban = kanbanClientRef.current;
		if (!kanban) return;
		applyColumnLayoutStyles(kanban);
	}, [applyColumnLayoutStyles]);

	return { containerRef, rebuild, refreshColumns, reflowLayout };
}
