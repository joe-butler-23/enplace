import { escapeHtml } from "@/shared/html";
import { KANBAN_ACTION_ATTRIBUTE, KANBAN_IMAGE_ATTRIBUTE } from "@/kanban-core";
import type { BaseKanbanItem } from "../types/kanban-config";
import { REMOVE_RECIPE_ACTION } from "./dropPolicy";

function isDirectImageSrc(value: string): boolean {
	const lower = value.toLowerCase();
	return (
		lower.startsWith("http://") ||
		lower.startsWith("https://") ||
		lower.startsWith("blob:") ||
		lower.startsWith("data:") ||
		lower.startsWith("app:")
	);
}

export function renderItemHTML<T extends BaseKanbanItem>(
	item: T,
	resolvedCoverImage?: string,
	getLoadedCardImageSrc?: (path: string) => string | undefined
): string {
	const type = item.type || "task";
	const coverImage = resolvedCoverImage ?? item.coverImage;
	const isRecipe = type === "recipe";

	const icon = getIconForType(type);
	const escapedTitle = escapeHtml(item.title);
	const escapedCover = coverImage ? escapeHtml(coverImage) : "";
	let coverImgAttrs = "";
	if (escapedCover) {
		if (isDirectImageSrc(escapedCover)) {
			coverImgAttrs = `src="${escapedCover}" `;
		} else {
			const cachedBlobSrc = getLoadedCardImageSrc?.(coverImage ?? "");
			if (cachedBlobSrc) {
				coverImgAttrs = `src="${escapeHtml(cachedBlobSrc)}" `;
			} else {
				coverImgAttrs = `${KANBAN_IMAGE_ATTRIBUTE}="${escapedCover}" `;
			}
		}
	}
	const coverHtml = coverImage
		? `<div class="card-cover"><img ${coverImgAttrs}alt="${escapedTitle}" loading="lazy" decoding="async" draggable="false" /></div>`
		: "";
	const removeBtnHtml = isRecipe
		? `<button class="card-remove-btn" ${KANBAN_ACTION_ATTRIBUTE}="${REMOVE_RECIPE_ACTION}" title="Unschedule recipe" aria-label="Unschedule recipe"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`
		: "";
	return `
			<div class="organiser-card-content">
				${removeBtnHtml}
				${coverHtml}
				<div class="card-header">
					${icon}
					<div class="card-title">${escapedTitle}</div>
				</div>
			</div>
		`;
}

export function getIconForType(type: string): string {
	// Return SVG icon based on type
	const icons: Record<string, string> = {
		recipe: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>`,
		exercise: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6.5 6.5 11 11"/><path d="m21 21-1-1"/><path d="m3 3 1 1"/><path d="m18 22 4-4"/><path d="m2 6 4-4"/><path d="m3 10 7-7"/><path d="m14 21 7-7"/></svg>`,
		task: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 12 2 2 4-4"/></svg>`,
		event: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/></svg>`,
		reminder: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 17h5l-1.4-1.4a2 2 0 0 1-.6-1.4V11a6 6 0 0 0-4-5.7V5a2 2 0 1 0-4 0v.3A6 6 0 0 0 6 11v3.2c0 .5-.2 1-.6 1.4L4 17h5"/><path d="M9 17a3 3 0 0 0 6 0"/></svg>`,
	};
	return icons[type] || icons.task;
}
