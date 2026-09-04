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
