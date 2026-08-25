import { App, TFile, moment } from "@/platform";
import {
	FieldMapping,
	FieldType,
	ColumnDefinition,
} from "../types/kanban-config";
import { normalizeFrontmatterDate } from "./scheduled-dates";
import { isTruthyMarked } from "../../cooking/utils/metadata";

const EXCLUDED_TASK_WORK_TYPES = new Set(["backlog", "habit", "phase"]);

function normalizeDateString(
	value: string,
	format: string
): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;

	const lowered = trimmed.toLowerCase();
	if (lowered === "null" || lowered === "undefined" || lowered === "none") {
		return undefined;
	}

	return normalizeFrontmatterDate(value, { format, onInvalid: trimmed }) ?? undefined;
}

function resolveDefaultColumnId(
	columns: ColumnDefinition[],
	lookup: ColumnLookup | undefined
): string | undefined {
	return lookup?.defaultColumnId ?? columns.find((column) => column.isDefault)?.id;
}

function isTaskType(value: unknown): boolean {
	return value === "task" || (Array.isArray(value) && value.includes("task"));
}

function isTaskOnlyPreset(presetTypeFilter?: string[]): boolean {
	return Boolean(
		presetTypeFilter &&
			presetTypeFilter.length === 1 &&
			presetTypeFilter.includes("task")
	);
}

function shouldExcludeTask(frontmatter: Record<string, unknown>): boolean {
	const workType = frontmatter.workType;
	const status = frontmatter.status;
	const isExcludedWorkType =
		typeof workType === "string" &&
		EXCLUDED_TASK_WORK_TYPES.has(workType.toLowerCase());
	const isDoneStatus =
		typeof status === "string" && status.toLowerCase() === "done";

	return isExcludedWorkType || isDoneStatus;
}

/**
 * Normalizes a frontmatter value based on field type
 */
export function normalizeFieldValue(
	value: unknown,
	type: FieldType,
	options?: { dateFormat?: string }
): string | boolean | number | undefined {
	if (value === null || value === undefined) return undefined;

	switch (type) {
		case "date": {
			const format = options?.dateFormat ?? "YYYY-MM-DD";

			if (typeof value === "string") {
				return normalizeDateString(value, format);
			}
			if (value instanceof Date) {
				return moment(value).format(format);
			}
			// Handle moment objects
			if (
				typeof value === "object" &&
				typeof (value as { format?: (f: string) => string }).format ===
					"function"
			) {
				return (value as { format: (f: string) => string }).format(
					format
				);
			}
			return String(value);
		}

		case "boolean": {
			if (typeof value === "boolean") return value;
			if (value === "true" || value === "yes" || value === 1) return true;
			if (value === "false" || value === "no" || value === 0)
				return false;
			return Boolean(value);
		}

		case "enum":
		case "string":
		default:
			return String(value).trim();
	}
}

/**
 * Reads a field value from frontmatter with fallback support
 */
export function readFieldValue(
	frontmatter: Record<string, unknown>,
	mapping: FieldMapping
): string | boolean | number | undefined {
	let rawValue = frontmatter[mapping.field];

	// Try fallback field if primary is empty
	if (
		(rawValue === undefined || rawValue === null) &&
		mapping.fallbackField
	) {
		rawValue = frontmatter[mapping.fallbackField];
	}

	return normalizeFieldValue(rawValue, mapping.type, {
		dateFormat: mapping.dateFormat,
	});
}

/**
 * Determines which column an item belongs to based on its frontmatter.
 * Returns undefined if the item doesn't belong to any column.
 */
export interface ColumnLookup {
	valueToColumnId: Map<string | boolean | number, string>;
	defaultColumnId?: string;
}

export function createColumnLookup(
	columns: ColumnDefinition[]
): ColumnLookup {
	const valueToColumnId = new Map<string | boolean | number, string>();
	let defaultColumnId: string | undefined;

	for (const column of columns) {
		if (column.isDefault) {
			defaultColumnId = column.id;
		}
		if (column.fieldValue !== undefined) {
			valueToColumnId.set(column.fieldValue, column.id);
		}
	}

	return { valueToColumnId, defaultColumnId };
}

export function getItemColumn(
	frontmatter: Record<string, unknown>,
	columns: ColumnDefinition[],
	mapping: FieldMapping,
	lookup?: ColumnLookup,
	presetTypeFilter?: string[]
): string | undefined {
	const fieldValue = readFieldValue(frontmatter, mapping);

	// First, check if the field value matches any specific column
	if (fieldValue !== undefined) {
		const matchedColumn = lookup?.valueToColumnId.get(fieldValue);
		if (matchedColumn) return matchedColumn;

		for (const column of columns) {
			if (column.fieldValue === fieldValue) {
				return column.id;
			}
		}
	}

	// If no field value match, check if item belongs to default column
	// Special case: for task planner, show all unscheduled tasks in marked column
	// (e.g., marked=true with no scheduled date, or any task with no scheduled date)
	if (!mapping.defaultField || fieldValue !== undefined) {
		return undefined;
	}

	const taskType = isTaskType(frontmatter.type);
	const taskOnlyPreset = isTaskOnlyPreset(presetTypeFilter);

	// For task planner: show all unscheduled tasks in marked column (excluding filtered tasks)
	// For weekly planner: show in marked column only if marked=true and no scheduled date
	if (taskOnlyPreset && taskType) {
		if (!shouldExcludeTask(frontmatter)) {
			return resolveDefaultColumnId(columns, lookup);
		}
		return undefined;
	}

	const defaultValue = frontmatter[mapping.defaultField];
	if (isTruthyMarked(defaultValue)) {
		return resolveDefaultColumnId(columns, lookup);
	}

	// Item doesn't belong to any column in the current view
	return undefined;
}

/**
 * Generic field manager for reading and writing frontmatter fields
 */
export class FieldManager {
	constructor(private app: App) {}

	/**
	 * Updates frontmatter fields based on column transfer
	 */
	async updateFieldForColumn(
		file: TFile,
		targetColumn: ColumnDefinition,
		mapping: FieldMapping
	): Promise<void> {
		await this.app.fileManager.processFrontMatter(
			file,
			(frontmatter) => {
				if (targetColumn.isDefault) {
					// Moving to default column - clear the field
					delete frontmatter[mapping.field];
					if (mapping.field === "scheduled") {
						delete frontmatter.scheduledDates;
					}
					if (mapping.fallbackField) {
						delete frontmatter[mapping.fallbackField];
					}
					// Set default field if configured
					if (mapping.defaultField) {
						frontmatter[mapping.defaultField] = true;
					}
				} else {
					// Moving to specific column - set the field value
					frontmatter[mapping.field] = targetColumn.fieldValue;
					if (mapping.field === "scheduled") {
						delete frontmatter.scheduledDates;
					}
					// Clear fallback field to avoid confusion
					if (mapping.fallbackField) {
						delete frontmatter[mapping.fallbackField];
					}
					// Clear default field if configured
					if (mapping.defaultField) {
						delete frontmatter[mapping.defaultField];
					}
				}
			}
		);
	}

	/**
	 * Read a single field value from a file
	 */
	async readField(
		file: TFile,
		mapping: FieldMapping
	): Promise<string | boolean | number | undefined> {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.frontmatter) return undefined;
		return readFieldValue(cache.frontmatter, mapping);
	}
}
