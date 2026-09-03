import { escapeHtml } from "@/shared/html";
import { KANBAN_ACTION_ATTRIBUTE } from "@/kanban-core";
import type { BaseKanbanItem } from "../types/kanban-config";
import { REMOVE_RECIPE_ACTION } from "./dropPolicy";

const RECIPE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>`;

export function renderItemHTML<T extends BaseKanbanItem>(
	item: T,
	coverImage: string
): string {
	const icon = RECIPE_ICON;
	const escapedTitle = escapeHtml(item.title);
	const coverHtml = coverImage
		? `<div class="card-cover"><img src="${escapeHtml(coverImage)}" alt="${escapedTitle}" decoding="async" draggable="false" /></div>`
		: "";
	const removeBtnHtml = `<button class="card-remove-btn" ${KANBAN_ACTION_ATTRIBUTE}="${REMOVE_RECIPE_ACTION}" title="Unschedule recipe" aria-label="Unschedule recipe"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
	const openBtnHtml = `<button type="button" class="card-open-btn card-header" aria-label="Open ${escapedTitle}">${icon}<span class="card-title">${escapedTitle}</span></button>`;
	return `
			<div class="organiser-card-content">
				${removeBtnHtml}
				${coverHtml}
				${openBtnHtml}
			</div>
		`;
}
