// Re-export all kanban configuration types
export * from "./kanban-config";

import { BaseKanbanItem } from "./kanban-config";

/**
 * Recipe item rendered by the weekly planner.
 */
export interface OrganiserItem extends BaseKanbanItem {
	coverImage?: string;
	date?: string; // YYYY-MM-DD
	added?: string; // YYYY-MM-DD
	marked?: boolean;
}
