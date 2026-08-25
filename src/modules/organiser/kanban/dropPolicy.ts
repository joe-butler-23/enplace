import type { DropOutcome, ResolveDropContext } from "@/kanban-core";

// The organiser module supplies its own drop, lane, and action policy to
// kanban-core, keeping those decisions separate from board mechanics.

export const MARKED_COLUMN_ID = "marked";
const MARKED_LANE_CLASS = "kanban-board--marked";
const MULTI_RECIPE_LANE_CLASS = "kanban-board--multi-recipe";
const RECIPE_CARD_SELECTOR = ".kanban-item.organiser-card--recipe-card";

/** Action name emitted by organiserCardTemplate.ts's recipe-remove button
 * (`data-kanban-action`) and matched by useKanbanBoard.ts's onAction
 * handler — defined once so the two sides can never drift. */
export const REMOVE_RECIPE_ACTION = "remove-recipe";

/** Lane-class config: only the marked column carries a structural class. */
export function laneClassNameFor(columnId: string): string {
	return columnId === MARKED_COLUMN_ID ? MARKED_LANE_CLASS : "";
}

// MEP's drop policy:
//  - dropping a card on marked never duplicates: a reminder is removed from
//    view (the drop still persists, e.g. marking it done), any other type is
//    a plain move ("duplicate blocked to marked");
//  - elsewhere, the duplicate modifier produces a real copy.
export function resolveOrganiserDrop(ctx: ResolveDropContext): DropOutcome {
	if (ctx.targetLaneId === MARKED_COLUMN_ID) {
		return String(ctx.cardType ?? "").toLowerCase() === "reminder" ? "remove" : "move";
	}
	return ctx.duplicateModifier ? "copy" : "move";
}

// Decorates rendered lane elements with organiser-specific recipe-density
// classing. Operates on lane elements directly, so it needs no jKanban-instance
// API (kanban.findBoard), only the DOM the core hands back after a build or
// patch flush.
export function decorateRenderedLanes(elements: Map<string, HTMLElement>, laneIds: string[]): void {
	for (const laneId of laneIds) {
		if (laneId === MARKED_COLUMN_ID) continue;
		const laneEl = elements.get(laneId);
		if (!laneEl) continue;
		const recipeCards = laneEl.querySelectorAll(RECIPE_CARD_SELECTOR).length;
		laneEl.classList.toggle(MULTI_RECIPE_LANE_CLASS, recipeCards > 1);
	}
}
