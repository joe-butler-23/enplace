import { App, TFile } from "@/platform";
import {
	BaseKanbanItem,
	BoardConfig,
	FieldMapping,
} from "../types/kanban-config";
import {
	ColumnLookup,
	createColumnLookup,
	getItemColumn,
	normalizeFieldValue,
} from "../utils/field-manager";
import { readScheduledDateList } from "../utils/scheduled-dates";
import { matchesItemFilter } from "./itemFilter";
import {
	applyPlannerOrder,
	PlannerOrderStore,
} from "../utils/planner-order";

function isArchivedPath(path: string): boolean {
	const parts = path.split("/");
	parts.pop(); // filename
	return parts.some((part) => part.toLowerCase() === "archive");
}

export interface BoardEntry<T extends BaseKanbanItem> {
	entryId: string;
	filePath: string;
	item: T;
	frontmatter: Record<string, unknown>;
	columnId: string;
}

interface BuildEntriesOptions {
	logPrefix?: string;
	logItemErrors?: boolean;
	columnLookup?: ColumnLookup;
	presetTypeFilter?: string[];
	plannerOrderStore?: PlannerOrderStore;
	plannerOrderPresetId?: string;
	manualOrder?: boolean;
}

function normalizeDateValues(
	value: unknown,
	dateFormat?: string
): string[] {
	const values = Array.isArray(value) ? value : [value];
	const normalized = new Set<string>();
	for (const entry of values) {
		const next = normalizeFieldValue(entry, "date", { dateFormat });
		if (typeof next === "string") {
			const trimmed = next.trim();
			if (trimmed) normalized.add(trimmed);
		}
	}
	return Array.from(normalized);
}

function resolveDateColumnIds<T extends BaseKanbanItem>(
	frontmatter: Record<string, unknown>,
	config: BoardConfig<T>,
	columnLookup: ColumnLookup
): string[] {
	const mapping = config.fieldMapping;
	const dateValues =
		mapping.field === "scheduled"
			? readScheduledDateList(frontmatter)
			: resolveMappedDateValues(frontmatter, mapping);
	if (dateValues.length === 0) return [];

	const columnIds = new Set<string>();
	const columnsByFieldValue = new Map<string, string>();
	for (const column of config.columns) {
		if (typeof column.fieldValue === "string") {
			columnsByFieldValue.set(column.fieldValue, column.id);
		}
	}
	for (const value of dateValues) {
		const lookupMatch = columnLookup.valueToColumnId.get(value);
		if (lookupMatch) {
			columnIds.add(lookupMatch);
			continue;
		}
		const directMatch = columnsByFieldValue.get(value);
		if (directMatch) {
			columnIds.add(directMatch);
		}
	}
	return Array.from(columnIds);
}

function resolveMappedDateValues(
	frontmatter: Record<string, unknown>,
	mapping: FieldMapping
): string[] {
	const dateValues = new Set<string>();
	const rawValues: unknown[] = [frontmatter[mapping.field]];
	if (mapping.fallbackField) {
		rawValues.push(frontmatter[mapping.fallbackField]);
	}
	for (const rawValue of rawValues) {
		for (const dateValue of normalizeDateValues(rawValue, mapping.dateFormat)) {
			dateValues.add(dateValue);
		}
	}
	return Array.from(dateValues);
}

function buildEntryItem<T extends BaseKanbanItem>(
	item: T,
	columnId: string,
	config: BoardConfig<T>
): T {
	if (config.fieldMapping.type === "date") {
		return {
			...item,
			date: columnId,
		} as T;
	}
	return item;
}

export function resolveBoardEntriesForFile<T extends BaseKanbanItem>(
	app: App,
	file: TFile,
	config: BoardConfig<T>,
	columnLookup: ColumnLookup,
	options: BuildEntriesOptions = {}
) : BoardEntry<T>[] {
	if (isArchivedPath(file.path)) return [];
	const cache = app.metadataCache.getFileCache(file);
	if (!cache) return [];

	const frontmatter = cache.frontmatter || {};
	if (!matchesItemFilter(file, cache, config.itemFilter)) return [];

	let item: T;
	try {
		item = config.itemTransformer
			? config.itemTransformer(file, frontmatter)
			: (({
					id: file.path,
					title: (frontmatter.title as string) || file.basename,
					path: file.path,
				} as T));
	} catch (err) {
		if (options.logItemErrors) {
			const prefix = options.logPrefix ? `[${options.logPrefix}] ` : "";
			console.warn(
				`${prefix}Item transformer failed for ${file.path}`,
				err
			);
		}
		return [];
	}

	let columnIds: string[] = [];
	if (config.fieldMapping.type === "date") {
		columnIds = resolveDateColumnIds(frontmatter, config, columnLookup);
	}
	if (columnIds.length === 0) {
		const singleColumnId = getItemColumn(
			frontmatter,
			config.columns,
			config.fieldMapping,
			columnLookup,
			options.presetTypeFilter
		);
		if (singleColumnId) {
			columnIds = [singleColumnId];
		}
	}
	if (columnIds.length === 0) return [];

	return columnIds.map((columnId) => ({
		entryId: `${file.path}::${columnId}`,
		filePath: file.path,
		item: buildEntryItem(item, columnId, config),
		frontmatter,
		columnId,
	}));
}

export function buildBoardEntries<T extends BaseKanbanItem>(
	app: App,
	config: BoardConfig<T>,
	options: BuildEntriesOptions = {}
	): {
		entriesByColumn: Map<string, BoardEntry<T>[]>;
		entriesByFile: Map<string, BoardEntry<T>>;
		entriesByItemId: Map<string, BoardEntry<T>>;
		entryIdsByFilePath: Map<string, Set<string>>;
		columnLookup: ColumnLookup;
	} {
	const columnLookup =
		options.columnLookup ?? createColumnLookup(config.columns);
	const entriesByColumn = new Map<string, BoardEntry<T>[]>();
	const entriesByFile = new Map<string, BoardEntry<T>>();
	const entriesByItemId = new Map<string, BoardEntry<T>>();
	const entryIdsByFilePath = new Map<string, Set<string>>();

	for (const column of config.columns) {
		entriesByColumn.set(column.id, []);
	}

	for (const file of app.vault.getMarkdownFiles()) {
		const entries = resolveBoardEntriesForFile(
			app,
			file,
			config,
			columnLookup,
			options
		);
		for (const entry of entries) {
			if (!entriesByFile.has(entry.filePath)) {
				entriesByFile.set(entry.filePath, entry);
			}
			entriesByItemId.set(entry.entryId, entry);
			const fileEntryIds = entryIdsByFilePath.get(entry.filePath) ?? new Set<string>();
			fileEntryIds.add(entry.entryId);
			entryIdsByFilePath.set(entry.filePath, fileEntryIds);
			const columnEntries = entriesByColumn.get(entry.columnId);
			if (columnEntries) {
				columnEntries.push(entry);
			}
		}
	}

	for (const [columnId, entries] of entriesByColumn) {
		const persistedIds =
			options.manualOrder && options.plannerOrderStore && options.plannerOrderPresetId
				? options.plannerOrderStore.get(config.id, options.plannerOrderPresetId, columnId)
				: undefined;
		entriesByColumn.set(columnId, applyPlannerOrder(entries, persistedIds));
	}

	return {
		entriesByColumn,
		entriesByFile,
		entriesByItemId,
		entryIdsByFilePath,
		columnLookup,
	};
}
