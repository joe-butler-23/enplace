export type DropOutcome = "move" | "copy" | "remove" | "reject";
export type ResolveDropContext = {
  cardId: string;
  sourceLaneId?: string;
  targetLaneId: string;
  isTemplate: boolean;
  duplicateModifier: boolean;
};

// The organiser keeps its drop, lane, and action policy separate from board rendering.

export const MARKED_COLUMN_ID = "marked";
const MARKED_LANE_CLASS = "kanban-board--marked";
const MULTI_RECIPE_LANE_CLASS = "kanban-board--multi-recipe";
const RECIPE_CARD_SELECTOR = ".kanban-item.organiser-card--recipe-card";

export const REMOVE_RECIPE_ACTION = "remove-recipe";

/** Lane-class config: only the marked column carries a structural class. */
export function laneClassNameFor(columnId: string): string {
	return columnId === MARKED_COLUMN_ID ? MARKED_LANE_CLASS : "";
}

// MEP's drop policy keeps marked moves singular and permits a real copy in day lanes.
export function resolveOrganiserDrop(ctx: ResolveDropContext): DropOutcome {
	if (ctx.targetLaneId === MARKED_COLUMN_ID) {
		return "move";
	}
	return ctx.duplicateModifier ? "copy" : "move";
}

// Decorates rendered lane elements with organiser-specific recipe-density
// classing.
export function decorateRenderedLanes(elements: Map<string, HTMLElement>, laneIds: string[]): void {
	for (const laneId of laneIds) {
		if (laneId === MARKED_COLUMN_ID) continue;
		const laneEl = elements.get(laneId);
		if (!laneEl) continue;
		const recipeCards = laneEl.querySelectorAll(RECIPE_CARD_SELECTOR).length;
		laneEl.classList.toggle(MULTI_RECIPE_LANE_CLASS, recipeCards > 1);
	}
}
