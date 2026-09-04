import type { BaseKanbanItem } from "../types/kanban-config";
import type { BoardEntry } from "../kanban/buildBoardsData";

type PlannerOrderEntries = Record<string, string[]>;

export function plannerOrderKey(boardId: string, presetId: string, columnId: string): string {
	return `${boardId}/${presetId}/${columnId}`;
}

function normalizeIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))];
}

export function stableEntryFallback<T extends BaseKanbanItem>(
	a: BoardEntry<T>,
	b: BoardEntry<T>
): number {
	const aType = String((a.item as { type?: unknown }).type ?? "").toLowerCase();
	const bType = String((b.item as { type?: unknown }).type ?? "").toLowerCase();
	const compare = (left: string, right: string): number =>
		left < right ? -1 : left > right ? 1 : 0;
	return (
		compare(aType, bType) ||
		compare(a.item.title.toLowerCase(), b.item.title.toLowerCase()) ||
		compare(a.filePath.toLowerCase(), b.filePath.toLowerCase()) ||
		compare(a.entryId, b.entryId)
	);
}

export function applyPlannerOrder<T extends BaseKanbanItem>(
	entries: BoardEntry<T>[],
	ids: readonly string[] | undefined
): BoardEntry<T>[] {
	const fallback = [...entries].sort(stableEntryFallback);
	if (!ids || ids.length === 0) return fallback;
	const byId = new Map(fallback.map((entry) => [entry.entryId, entry]));
	const ordered: BoardEntry<T>[] = [];
	for (const id of ids) {
		const entry = byId.get(id);
		if (!entry) continue;
		ordered.push(entry);
		byId.delete(id);
	}
	for (const entry of fallback) {
		if (byId.has(entry.entryId)) ordered.push(entry);
	}
	return ordered;
}

export class PlannerOrderStore {
	private entries: PlannerOrderEntries = {};

	async load(): Promise<void> {}

	get(boardId: string, presetId: string, columnId: string): string[] {
		return [...(this.entries[plannerOrderKey(boardId, presetId, columnId)] ?? [])];
	}

	async replace(boardId: string, presetId: string, columnId: string, entryIds: readonly string[]): Promise<void> {
		await this.replaceMany(new Map([[plannerOrderKey(boardId, presetId, columnId), entryIds]]));
	}

	async replaceMany(updates: ReadonlyMap<string, readonly string[]>): Promise<void> {
		for (const [key, entryIds] of updates) {
			const ids = normalizeIds(entryIds);
			if (ids.length) this.entries[key] = ids; else delete this.entries[key];
		}
	}
}
