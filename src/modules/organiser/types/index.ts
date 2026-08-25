// Re-export all kanban configuration types
export * from "./kanban-config";

import { BaseKanbanItem } from "./kanban-config";

export type OrganiserItemType =
	| "recipe"
	| "exercise"
	| "task"
	| "event"
	| "reminder"
	| "unknown";

/**
 * Extended item for the Weekly Organiser (backward compatible)
 */
export interface OrganiserItem extends BaseKanbanItem {
	type: OrganiserItemType;
	coverImage?: string;
	date?: string; // YYYY-MM-DD
	added?: string; // YYYY-MM-DD
	marked?: boolean;
}
