// The contract's selector map (see docs/kanban-core-contract.md): the
// three structural roles the core reads/writes DOM through, plus how each
// producer embeds a lane/card id. Two DOM producers, one behaviour: only the
// selectors and id accessors vary between them.

// Non-structural attribute: any interactive element inside a card carrying
// this attribute is delegated to `onAction` instead of being treated as a
// card click (see lifecycle.ts's click handler).
export const KANBAN_ACTION_ATTRIBUTE = "data-kanban-action";

export type KanbanSelectorMap = {
	/** Matches a lane (column) container within the board container. */
	lane: string;
	/** Matches the direct-child-holding cards container within a lane. */
	cardsContainer: string;
	/** Matches a card element (a direct child of the cards container). */
	card: string;
	/** Classes owned by the markup contract rather than card data. */
	structuralCardClasses: readonly string[];
	readLaneId: (laneEl: Element) => string | null;
	writeLaneId: (laneEl: Element, id: string) => void;
	readCardId: (cardEl: Element) => string | null;
	writeCardId: (cardEl: Element, id: string) => void;
};

// Canonical contract markup: `data-kanban-lane` / `data-kanban-cards` /
// `data-kanban-card`, ids read/written as plain attributes. This is the
// default a server-rendered consumer can match with zero
// configuration.
export const CONTRACT_SELECTORS: KanbanSelectorMap = {
	lane: "[data-kanban-lane]",
	cardsContainer: "[data-kanban-cards]",
	card: "[data-kanban-card]",
	structuralCardClasses: [],
	readLaneId: (laneEl) => laneEl.getAttribute("data-kanban-lane"),
	writeLaneId: (laneEl, id) => laneEl.setAttribute("data-kanban-lane", id),
	readCardId: (cardEl) => cardEl.getAttribute("data-kanban-card"),
	writeCardId: (cardEl, id) => cardEl.setAttribute("data-kanban-card", id),
};

// MEP's jKanban markup (verified against src/vendor/jkanban-patched.js and
// src/kanban-core/lifecycle.ts's columnOrder helper): `.kanban-board[data-id]`
// / `.kanban-drag` / `.kanban-item[data-eid]`, ids read/written via
// `dataset.id` / `dataset.eid`.
export const JKANBAN_SELECTORS: KanbanSelectorMap = {
	lane: ".kanban-board[data-id]",
	cardsContainer: ".kanban-drag",
	card: ".kanban-item[data-eid]",
	structuralCardClasses: ["kanban-item"],
	readLaneId: (laneEl) => (laneEl as HTMLElement).dataset.id ?? null,
	writeLaneId: (laneEl, id) => {
		(laneEl as HTMLElement).dataset.id = id;
	},
	readCardId: (cardEl) => (cardEl as HTMLElement).dataset.eid ?? null,
	writeCardId: (cardEl, id) => {
		(cardEl as HTMLElement).dataset.eid = id;
	},
};

export type SelectorAccessors = {
	laneId: (laneEl: Element) => string | null;
	cardId: (cardEl: Element) => string | null;
	findLane: (container: ParentNode, id: string) => HTMLElement | null;
	cardsContainer: (laneEl: Element) => HTMLElement | null;
};

// Tiny accessor functions bound to a selector map, not a class hierarchy:
// callers get plain functions (laneId(el), cardId(el), findLane(container,
// id), cardsContainer(laneEl)) closed over whichever map (contract or
// jKanban) they were built from.
export function createSelectorAccessors(selectors: KanbanSelectorMap): SelectorAccessors {
	return {
		laneId: (laneEl) => selectors.readLaneId(laneEl),
		cardId: (cardEl) => selectors.readCardId(cardEl),
		findLane: (container, id) => {
			for (const laneEl of Array.from(container.querySelectorAll<HTMLElement>(selectors.lane))) {
				if (selectors.readLaneId(laneEl) === id) return laneEl;
			}
			return null;
		},
		cardsContainer: (laneEl) => laneEl.querySelector<HTMLElement>(selectors.cardsContainer),
	};
}
