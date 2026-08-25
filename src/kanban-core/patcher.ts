import { classTokens, type KanbanCardData } from "./lifecycle";
import { CONTRACT_SELECTORS, createSelectorAccessors, type KanbanSelectorMap } from "./selectors";

export type KanbanLanePatch = {
	id: string;
	cards: KanbanCardData[];
};

export type BuildCardElement = (card: KanbanCardData) => HTMLElement;

export type BoardPatcherOptions = {
	container: HTMLElement;
	selectors?: KanbanSelectorMap;
	buildCardElement?: BuildCardElement;
	onLanesRendered?: (laneIds: string[], elements: Map<string, HTMLElement>) => void;
};

export type BoardPatcher = {
	patchLanes: (lanes: KanbanLanePatch[]) => string[];
	invalidateLanes: (laneIds: Iterable<string>) => void;
	snapshotFromDom: () => void;
	rekeyCard: (element: HTMLElement, newId: string) => void;
};

type CardState = {
	html: string;
	classes: string[];
	elementTimingIdentifier?: string;
};

type LaneState = {
	order: string[];
	cards: Map<string, CardState>;
};

function sameArray(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameCardState(left: CardState | undefined, right: CardState): boolean {
	return Boolean(
		left
		&& left.html === right.html
		&& left.elementTimingIdentifier === right.elementTimingIdentifier
		&& sameArray(left.classes, right.classes)
	);
}

function sameLaneState(left: LaneState | undefined, right: LaneState): boolean {
	if (!left || !sameArray(left.order, right.order)) return false;
	for (const id of right.order) {
		if (!sameCardState(left.cards.get(id), right.cards.get(id)!)) return false;
	}
	return true;
}

function applyElementTimingIdentifier(
	element: HTMLElement,
	identifier: string | undefined
): void {
	if (identifier) element.setAttribute("elementtiming", identifier);
	else element.removeAttribute("elementtiming");
}

export function buildJKanbanCardElement(card: KanbanCardData): HTMLElement {
	const element = document.createElement("div");
	element.classList.add("kanban-item", ...classTokens(card.classes));
	element.dataset.eid = card.id;
	applyElementTimingIdentifier(element, card.elementTimingIdentifier);
	element.innerHTML = card.html;
	return element;
}

export function createBoardPatcher(options: BoardPatcherOptions): BoardPatcher {
	const { container, buildCardElement, onLanesRendered } = options;
	const selectors = options.selectors ?? CONTRACT_SELECTORS;
	const accessors = createSelectorAccessors(selectors);
	const laneStates = new Map<string, LaneState>();
	const invalidatedLaneIds = new Set<string>();
	let trackedCards = new WeakSet<HTMLElement>();

	function normaliseClasses(classes: Iterable<string>): string[] {
		return classTokens([...selectors.structuralCardClasses, ...classes]).sort();
	}

	function stateForCard(card: KanbanCardData): CardState {
		return {
			html: card.html,
			classes: normaliseClasses(card.classes ?? []),
			elementTimingIdentifier: card.elementTimingIdentifier,
		};
	}

	function stateForElement(element: HTMLElement): CardState {
		return {
			html: element.innerHTML,
			classes: normaliseClasses(element.classList),
			elementTimingIdentifier: element.getAttribute("elementtiming") ?? undefined,
		};
	}

	function stateForLane(lane: KanbanLanePatch): LaneState {
		if (!lane.id) throw new Error("Kanban lane id cannot be empty");
		const cards = new Map<string, CardState>();
		for (const card of lane.cards) {
			if (!card.id) throw new Error("Kanban card id cannot be empty");
			if (cards.has(card.id)) {
				throw new Error(`Kanban patch contains duplicate card id "${card.id}"`);
			}
			cards.set(card.id, stateForCard(card));
		}
		return { order: lane.cards.map((card) => card.id), cards };
	}

	function indexLanes(): Map<string, { lane: HTMLElement; cards: HTMLElement }> {
		const indexed = new Map<string, { lane: HTMLElement; cards: HTMLElement }>();
		for (const lane of Array.from(container.querySelectorAll<HTMLElement>(selectors.lane))) {
			const id = accessors.laneId(lane);
			const cards = accessors.cardsContainer(lane);
			if (!id || !cards) throw new Error("Kanban lane is missing its id or cards container");
			if (indexed.has(id)) throw new Error(`Kanban DOM contains duplicate lane id "${id}"`);
			indexed.set(id, { lane, cards });
		}
		return indexed;
	}

	function indexCards(): Map<string, HTMLElement> {
		const indexed = new Map<string, HTMLElement>();
		for (const card of Array.from(container.querySelectorAll<HTMLElement>(selectors.card))) {
			const id = accessors.cardId(card);
			if (!id) continue;
			if (indexed.has(id)) throw new Error(`Kanban DOM contains duplicate card id "${id}"`);
			indexed.set(id, card);
			trackedCards.add(card);
		}
		return indexed;
	}

	function cardIdsOf(cards: HTMLElement): string[] {
		return Array.from(cards.children, (card) => accessors.cardId(card)).filter(
			(id): id is string => Boolean(id),
		);
	}

	function snapshotFromDom(): void {
		const nextStates = new Map<string, LaneState>();
		const seenCardIds = new Set<string>();
		trackedCards = new WeakSet<HTMLElement>();

		for (const [laneId, { cards }] of indexLanes()) {
			const order: string[] = [];
			const cardStates = new Map<string, CardState>();
			for (const card of Array.from(cards.children) as HTMLElement[]) {
				const cardId = accessors.cardId(card);
				if (!cardId) continue;
				if (seenCardIds.has(cardId)) {
					throw new Error(`Kanban DOM contains duplicate card id "${cardId}"`);
				}
				seenCardIds.add(cardId);
				order.push(cardId);
				cardStates.set(cardId, stateForElement(card));
				trackedCards.add(card);
			}
			nextStates.set(laneId, { order, cards: cardStates });
		}

		laneStates.clear();
		for (const [laneId, state] of nextStates) laneStates.set(laneId, state);
		invalidatedLaneIds.clear();
	}

	function invalidateLanes(laneIds: Iterable<string>): void {
		for (const laneId of laneIds) invalidatedLaneIds.add(laneId);
	}

	function buildAndInsert(cards: HTMLElement, card: KanbanCardData): HTMLElement {
		if (!buildCardElement) {
			throw new Error(`Kanban patch requires buildCardElement for card "${card.id}"`);
		}
		const element = buildCardElement(card);
		cards.appendChild(element);
		trackedCards.add(element);
		return element;
	}

	function updateInPlace(element: HTMLElement, card: KanbanCardData): HTMLElement {
		element.innerHTML = card.html;
		applyElementTimingIdentifier(element, card.elementTimingIdentifier);
		const nextClasses = new Set(normaliseClasses(card.classes ?? []));
		for (const className of Array.from(element.classList)) {
			if (!nextClasses.has(className)) element.classList.remove(className);
		}
		for (const className of nextClasses) element.classList.add(className);
		selectors.writeCardId(element, card.id);
		return element;
	}

	function patchLanes(lanes: KanbanLanePatch[]): string[] {
		const nextByLane = new Map<string, LaneState>();
		for (const lane of lanes) {
			if (nextByLane.has(lane.id)) {
				throw new Error(`Kanban patch contains duplicate lane id "${lane.id}"`);
			}
			nextByLane.set(lane.id, stateForLane(lane));
		}

		const effectiveStates = new Map(laneStates);
		for (const [laneId, state] of nextByLane) effectiveStates.set(laneId, state);
		const seenCardIds = new Set<string>();
		for (const state of effectiveStates.values()) {
			for (const id of state.order) {
				if (seenCardIds.has(id)) {
					throw new Error(`Kanban patch contains duplicate card id "${id}"`);
				}
				seenCardIds.add(id);
			}
		}

		const changed = lanes.filter((lane) => (
			invalidatedLaneIds.has(lane.id)
			|| !sameLaneState(laneStates.get(lane.id), nextByLane.get(lane.id)!)
		));
		if (changed.length === 0) return [];

		const lanesById = indexLanes();
		for (const lane of changed) {
			if (!lanesById.has(lane.id)) {
				throw new Error(`Kanban patch references unknown lane "${lane.id}"`);
			}
		}

		const cardsById = indexCards();
		const previousCardsById = new Map<string, CardState>();
		for (const state of laneStates.values()) {
			for (const [id, card] of state.cards) previousCardsById.set(id, card);
		}

		if (!buildCardElement) {
			for (const lane of changed) {
				const nextState = nextByLane.get(lane.id)!;
				for (const card of lane.cards) {
					const existing = cardsById.get(card.id);
					if (!existing || !sameCardState(stateForElement(existing), nextState.cards.get(card.id)!)) {
						throw new Error(`Kanban patch requires buildCardElement for card "${card.id}"`);
					}
				}
			}
		}

		const desiredCardIds = new Set(lanes.flatMap((lane) => lane.cards.map((card) => card.id)));
		const renderedElements = new Map<string, HTMLElement>();

		for (const lane of changed) {
			const { lane: laneElement, cards: cardsElement } = lanesById.get(lane.id)!;
			const nextState = nextByLane.get(lane.id)!;
			const existingIds = cardIdsOf(cardsElement);
			const sameOrder = sameArray(existingIds, nextState.order);
			renderedElements.set(lane.id, laneElement);

			if (sameOrder) {
				for (const card of lane.cards) {
					if (sameCardState(previousCardsById.get(card.id), nextState.cards.get(card.id)!)) continue;
					const existing = cardsById.get(card.id);
					if (existing) updateInPlace(existing, card);
				}
				laneStates.set(lane.id, nextState);
				continue;
			}

			const nextIdSet = new Set(nextState.order);
			for (const id of existingIds) {
				if (nextIdSet.has(id) || desiredCardIds.has(id)) continue;
				cardsById.get(id)?.remove();
				cardsById.delete(id);
			}

			for (let index = 0; index < lane.cards.length; index++) {
				const card = lane.cards[index];
				const nextCardState = nextState.cards.get(card.id)!;
				let element = cardsById.get(card.id);
				if (!element) {
					element = buildAndInsert(cardsElement, card);
					cardsById.set(card.id, element);
				} else if (
					!sameCardState(previousCardsById.get(card.id), nextCardState)
					&& !sameCardState(stateForElement(element), nextCardState)
				) {
					updateInPlace(element, card);
				}

				const target = cardsElement.children[index] ?? null;
				if (target !== element) cardsElement.insertBefore(element, target);
			}
			laneStates.set(lane.id, nextState);
		}

		const changedIds = changed.map((lane) => lane.id);
		for (const laneId of changedIds) invalidatedLaneIds.delete(laneId);
		onLanesRendered?.(changedIds, renderedElements);
		return changedIds;
	}

	function rekeyCard(element: HTMLElement, newId: string): void {
		const oldId = accessors.cardId(element);
		if (!oldId) throw new Error("Kanban card has no id");
		if (!newId) throw new Error("Kanban card id cannot be empty");
		if (oldId === newId) return;

		for (const card of Array.from(container.querySelectorAll<HTMLElement>(selectors.card))) {
			if (card !== element && accessors.cardId(card) === newId) {
				throw new Error(`Kanban DOM already contains card id "${newId}"`);
			}
		}

		let trackedState: LaneState | undefined;
		for (const state of laneStates.values()) {
			if (state.cards.has(newId)) throw new Error(`Kanban state already contains card id "${newId}"`);
			if (!trackedCards.has(element) || !state.cards.has(oldId)) continue;
			if (trackedState) throw new Error(`Kanban state contains duplicate card id "${oldId}"`);
			trackedState = state;
		}

		selectors.writeCardId(element, newId);
		trackedCards.add(element);
		if (!trackedState) return;

		const cardState = trackedState.cards.get(oldId)!;
		const index = trackedState.order.indexOf(oldId);
		trackedState.cards.delete(oldId);
		trackedState.cards.set(newId, cardState);
		if (index !== -1) trackedState.order[index] = newId;
	}

	return { patchLanes, invalidateLanes, snapshotFromDom, rekeyCard };
}
