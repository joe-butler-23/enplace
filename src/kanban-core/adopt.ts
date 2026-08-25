import type { KanbanMove } from "./lifecycle";
import { settleMove, type MoveSettlementOutcome, type SettlementResult } from "./settle-drop";
import { CONTRACT_SELECTORS, createSelectorAccessors, type KanbanSelectorMap } from "./selectors";

export type AdoptKanbanSource = {
	onMove: (move: KanbanMove) => Promise<MoveSettlementOutcome> | MoveSettlementOutcome;
	onMoveError?: (error: unknown, move: KanbanMove) => Promise<void> | void;
};

export type AdoptKanbanCoreOptions = {
	selectors?: KanbanSelectorMap;
	source: AdoptKanbanSource;
	onSettled?: (result: SettlementResult, move: KanbanMove) => void;
};

export type AdoptDrop = {
	cardId: string;
	targetLaneId: string;
	index: number;
};

export type AdoptKanbanCore = {
	adopt: (container: HTMLElement) => void;
	beginDrag: (cardId: string) => void;
	handleDrop: (drop: AdoptDrop) => Promise<SettlementResult>;
	cancelDrag: () => void;
	destroy: () => void;
};

type CardLocation = {
	card: HTMLElement;
	laneId: string;
	cards: HTMLElement;
};

type DragState = {
	root: HTMLElement;
	version: number;
	cardId: string;
	sourceLaneId: string;
	sourceOrder: string[];
};

type DropRequest = {
	root: HTMLElement;
	version: number;
	drop: AdoptDrop;
};

export function createAdoptKanbanCore(options: AdoptKanbanCoreOptions): AdoptKanbanCore {
	const selectors = options.selectors ?? CONTRACT_SELECTORS;
	const accessors = createSelectorAccessors(selectors);
	const confirmedOrders = new Map<string, string[]>();
	const pendingDrops = new Map<string, Promise<SettlementResult>>();
	let root: HTMLElement | null = null;
	let version = 0;
	let blockedVersion: number | null = null;
	let drag: DragState | null = null;
	let queue: Promise<void> | null = null;

	function cardElements(cards: HTMLElement): HTMLElement[] {
		return Array.from(cards.children).filter((element): element is HTMLElement => accessors.cardId(element) !== null);
	}

	function orderOf(cards: HTMLElement): string[] {
		return cardElements(cards).map((card) => accessors.cardId(card)!).filter(Boolean);
	}

	function findCard(container: HTMLElement, cardId: string): CardLocation | null {
		for (const lane of Array.from(container.querySelectorAll<HTMLElement>(selectors.lane))) {
			const laneId = accessors.laneId(lane);
			const cards = accessors.cardsContainer(lane);
			if (!laneId || !cards) continue;
			for (const card of cardElements(cards)) {
				if (accessors.cardId(card) === cardId) return { card, laneId, cards };
			}
		}
		return null;
	}

	function restoreOrder(container: HTMLElement, laneId: string, order: string[]): void {
		const lane = accessors.findLane(container, laneId);
		const cards = lane && accessors.cardsContainer(lane);
		if (!cards) return;
		for (let index = 0; index < order.length; index++) {
			const location = findCard(container, order[index]);
			if (!location) continue;
			const reference = cardElements(cards)[index] ?? null;
			if (reference !== location.card) cards.insertBefore(location.card, reference);
		}
	}

	function restoreOrders(container: HTMLElement, orders: Map<string, string[]>): void {
		for (const [laneId, order] of orders) restoreOrder(container, laneId, order);
	}

	function cacheConfirmedOrders(move: KanbanMove): void {
		confirmedOrders.set(move.sourceLaneId, [...move.sourceOrder]);
		confirmedOrders.set(move.targetLaneId, [...move.targetOrder]);
	}

	function reapplyConfirmedOrder(container: HTMLElement): void {
		for (const lane of Array.from(container.querySelectorAll<HTMLElement>(selectors.lane))) {
			const laneId = accessors.laneId(lane);
			const cards = accessors.cardsContainer(lane);
			if (!laneId || !cards) continue;
			const confirmed = confirmedOrders.get(laneId);
			if (!confirmed) continue;

			const current = cardElements(cards);
			const byId = new Map(current.map((card) => [accessors.cardId(card)!, card]));
			const ordered = confirmed.flatMap((cardId) => {
				const card = byId.get(cardId);
				return card ? [card] : [];
			});
			const orderedIds = new Set(ordered.map((card) => accessors.cardId(card)!));
			const slots = current.flatMap((card, index) => orderedIds.has(accessors.cardId(card)!) ? [index] : []);
			const desired = [...current];
			for (let index = 0; index < slots.length; index++) desired[slots[index]] = ordered[index];
			for (let index = 0; index < desired.length; index++) {
				const currentCards = cardElements(cards);
				const card = desired[index];
				if (currentCards[index] !== card) cards.insertBefore(card, currentCards[index] ?? null);
			}
		}
	}

	function currentRoot(): HTMLElement {
		if (!root) throw new Error("Kanban core has no adopted root");
		return root;
	}

	function isCurrent(request: DropRequest): boolean {
		return request.root === root && request.version === version;
	}

	function dropKey(request: DropRequest): string {
		return JSON.stringify([request.version, request.drop.cardId, request.drop.targetLaneId, request.drop.index]);
	}

	function enqueue(request: DropRequest): Promise<SettlementResult> {
		const run = () => settleDrop(request);
		const promise = queue ? queue.then(run) : run();
		const settled = promise.then(() => undefined, () => undefined);
		queue = settled;
		settled.then(() => {
			if (queue === settled) queue = null;
		});
		return promise;
	}

	function beginDrag(cardId: string): void {
		cancelDrag();
		const activeRoot = currentRoot();
		const location = findCard(activeRoot, cardId);
		if (!location) throw new Error(`Kanban card not found: ${cardId}`);
		drag = {
			root: activeRoot,
			version,
			cardId,
			sourceLaneId: location.laneId,
			sourceOrder: orderOf(location.cards),
		};
	}

	function cancelDrag(): void {
		if (drag && drag.root === root && drag.version === version) restoreOrder(drag.root, drag.sourceLaneId, drag.sourceOrder);
		drag = null;
	}

	async function settleDrop(request: DropRequest): Promise<SettlementResult> {
		if (!isCurrent(request) || blockedVersion === request.version) return "indeterminate";

		const source = findCard(request.root, request.drop.cardId);
		const targetLane = accessors.findLane(request.root, request.drop.targetLaneId);
		const targetCards = targetLane && accessors.cardsContainer(targetLane);
		if (!source || !targetCards) throw new Error(`Kanban drop target not found: ${request.drop.cardId}`);

		const remainingTargetCards = cardElements(targetCards).filter((card) => card !== source.card);
		if (!Number.isInteger(request.drop.index) || request.drop.index < 0 || request.drop.index > remainingTargetCards.length) {
			throw new RangeError(`Invalid kanban drop index: ${request.drop.index}`);
		}

		const orders = new Map<string, string[]>();
		orders.set(source.laneId, orderOf(source.cards));
		if (source.laneId !== request.drop.targetLaneId) orders.set(request.drop.targetLaneId, orderOf(targetCards));

		const reference = remainingTargetCards[request.drop.index] ?? null;
		if (reference !== source.card) targetCards.insertBefore(source.card, reference);

		const move: KanbanMove = {
			cardId: request.drop.cardId,
			sourceLaneId: source.laneId,
			targetLaneId: request.drop.targetLaneId,
			index: request.drop.index,
			sourceOrder: orderOf(source.cards),
			targetOrder: source.cards === targetCards ? orderOf(source.cards) : orderOf(targetCards),
		};
		const result = await settleMove(move, {
			...options.source,
			onMoveError: (error, settledMove) => {
				if (isCurrent(request)) return options.source.onMoveError?.(error, settledMove);
			},
			onSettled: (settled, settledMove) => {
				if (isCurrent(request)) options.onSettled?.(settled, settledMove);
			},
		}, () => {
			if (isCurrent(request)) restoreOrders(request.root, orders);
		});

		if (!isCurrent(request)) return "indeterminate";
		if (result === "indeterminate") blockedVersion = request.version;
		if (result === "confirmed") cacheConfirmedOrders(move);
		return result;
	}

	function handleDrop(drop: AdoptDrop): Promise<SettlementResult> {
		const activeRoot = currentRoot();
		cancelDrag();
		if (blockedVersion === version) return Promise.resolve("indeterminate");
		const request: DropRequest = { root: activeRoot, version, drop };
		const key = dropKey(request);
		const duplicate = pendingDrops.get(key);
		if (duplicate) return duplicate;

		const promise = enqueue(request);
		pendingDrops.set(key, promise);
		promise.then(
			() => { if (pendingDrops.get(key) === promise) pendingDrops.delete(key); },
			() => { if (pendingDrops.get(key) === promise) pendingDrops.delete(key); },
		);
		return promise;
	}

	return {
		adopt(container) {
			root = container;
			version += 1;
			drag = null;
			reapplyConfirmedOrder(container);
		},
		beginDrag,
		handleDrop,
		cancelDrag,
		destroy() {
			version += 1;
			root = null;
			drag = null;
		},
	};
}
