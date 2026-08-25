import type { App } from "@/platform";
import type { BaseKanbanItem } from "../types/kanban-config";
import type { BoardEntry } from "../kanban/buildBoardsData";

export const PLANNER_ORDER_VERSION = 1;
export const PLANNER_ORDER_FILE = "planner-order.json";

export type PlannerOrderDocument = {
	version: typeof PLANNER_ORDER_VERSION;
	entries: Record<string, string[]>;
};

export function plannerOrderKey(
	boardId: string,
	presetId: string,
	columnId: string
): string {
	return `${boardId}/${presetId}/${columnId}`;
}

export function createEmptyPlannerOrder(): PlannerOrderDocument {
	return { version: PLANNER_ORDER_VERSION, entries: {} };
}

function normalizeIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return Array.from(
		new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))
	);
}

export function parsePlannerOrder(value: unknown): PlannerOrderDocument {
	if (!value || typeof value !== "object") return createEmptyPlannerOrder();
	const raw = value as { version?: unknown; entries?: unknown };
	if (raw.version !== PLANNER_ORDER_VERSION || !raw.entries || typeof raw.entries !== "object") {
		return createEmptyPlannerOrder();
	}
	const entries: Record<string, string[]> = {};
	for (const [key, ids] of Object.entries(raw.entries as Record<string, unknown>)) {
		const normalized = normalizeIds(ids);
		if (normalized.length > 0) entries[key] = normalized;
	}
	return { version: PLANNER_ORDER_VERSION, entries };
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
	private document: PlannerOrderDocument = createEmptyPlannerOrder();
	private loaded = false;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(private readonly app: App) {}

	private get path(): string {
		const configDir = (this.app.vault as { configDir?: string }).configDir ?? ".obsidian";
		return `${configDir}/${PLANNER_ORDER_FILE}`;
	}

	isLoaded(): boolean {
		return this.loaded;
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		const adapter = this.app.vault.adapter;
		try {
			if (await adapter.exists(this.path)) {
				const raw = await adapter.read(this.path);
				this.document = parsePlannerOrder(JSON.parse(raw));
			} else {
				this.document = createEmptyPlannerOrder();
			}
		} catch {
			this.document = createEmptyPlannerOrder();
		}
		this.loaded = true;
	}

	get(boardId: string, presetId: string, columnId: string): string[] {
		return [...(this.document.entries[plannerOrderKey(boardId, presetId, columnId)] ?? [])];
	}

	async replace(
		boardId: string,
		presetId: string,
		columnId: string,
		entryIds: readonly string[]
	): Promise<void> {
		await this.replaceMany(
			new Map([[plannerOrderKey(boardId, presetId, columnId), entryIds]])
		);
	}

	async replaceMany(updates: ReadonlyMap<string, readonly string[]>): Promise<void> {
		await this.load();
		const next = createEmptyPlannerOrder();
		next.entries = { ...this.document.entries };
		for (const [key, entryIds] of updates) {
			const normalized = normalizeIds(entryIds);
			if (normalized.length > 0) next.entries[key] = normalized;
			else delete next.entries[key];
		}
		const previous = this.document;
		this.document = next;
		this.writeChain = this.writeChain.then(async () => {
			try {
				await this.write(next);
			} catch (error) {
				this.document = previous;
				throw error;
			}
		});
		return this.writeChain;
	}

	async reconcileMany(updates: ReadonlyMap<string, readonly string[]>): Promise<void> {
		await this.load();
		const next = createEmptyPlannerOrder();
		next.entries = { ...this.document.entries };
		for (const [key, validIds] of updates) {
			const valid = new Set(normalizeIds(validIds));
			const previous = next.entries[key] ?? [];
			const merged = previous.filter((id) => valid.has(id));
			const mergedIds = new Set(merged);
			for (const id of normalizeIds(validIds)) {
				if (!mergedIds.has(id)) {
					merged.push(id);
					mergedIds.add(id);
				}
			}
			if (merged.length > 0) next.entries[key] = merged;
			else delete next.entries[key];
		}
		const previous = this.document;
		this.document = next;
		this.writeChain = this.writeChain.then(async () => {
			try {
				await this.write(next);
			} catch (error) {
				this.document = previous;
				throw error;
			}
		});
		return this.writeChain;
	}

	private async write(document: PlannerOrderDocument): Promise<void> {
		const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & {
			rename?: (from: string, to: string) => Promise<void>;
		};
		const configDir = (this.app.vault as { configDir?: string }).configDir ?? ".obsidian";
		await adapter.mkdir(configDir);
		const payload = `${JSON.stringify(document, null, 2)}\n`;
		const temporaryPath = `${this.path}.tmp`;
		await adapter.write(temporaryPath, payload);
		if (adapter.rename) {
			await adapter.rename(temporaryPath, this.path);
			return;
		}
		await adapter.write(this.path, payload);
		try {
			await adapter.remove(temporaryPath);
		} catch {
			// Best effort cleanup for adapters without atomic rename support.
		}
	}
}
