import { TFile } from "@/platform";

/**
 * Supported frontmatter field types for normalization
 */
export type FieldType = "date" | "enum" | "boolean" | "string";

/**
 * Configuration for mapping board columns to frontmatter fields
 */
export interface FieldMapping {
	/** Primary frontmatter field to read/write (e.g., "scheduled", "status") */
	field: string;
	/** Field type for normalization */
	type: FieldType;
	/** Optional fallback field for reading (e.g., "date" as fallback for "scheduled") */
	fallbackField?: string;
	/** For boolean fields: the field that indicates "default column" membership */
	defaultField?: string;
	/** Date format for date fields (default: 'YYYY-MM-DD') */
	dateFormat?: string;
}

/**
 * Definition for a single Kanban column
 */
export interface ColumnDefinition {
	/** Unique identifier for the column */
	id: string;
	/** Display title */
	title: string;
	/** Value to match in frontmatter (undefined = default/catch-all column) */
	fieldValue: string | boolean | number | undefined;
	/** Whether this is the default column for items without a value */
	isDefault?: boolean;
	/** Optional column-specific styling class */
	className?: string;
	/** Optional explicit grid row placement (e.g. "1", "1 / span 2") */
	gridRow?: string;
	/** Optional explicit grid column placement (e.g. "2", "2 / 4") */
	gridColumn?: string;
}

/**
 * Item filter configuration
 */
export interface ItemFilter {
	/** Filter by file path pattern (regex) */
	pathPattern?: RegExp;
	/** Filter by required tags (item must have at least one) */
	requiredTags?: string[];
	/** Filter by frontmatter field existence */
	requiredFields?: string[];
	/** Custom filter function */
	customFilter?: (
		file: TFile,
		frontmatter: Record<string, unknown>
	) => boolean;
}

/**
 * Base interface for Kanban items - all board items must extend this
 */
export interface BaseKanbanItem {
	/** Unique identifier (file path) */
	id: string;
	/** Display title */
	title: string;
	/** File path */
	path: string;
	/** Optional item metadata used by shared card and drag behaviour */
	type?: string;
	coverImage?: string;
}

/**
 * Complete board configuration
 */
export interface BoardConfig<T extends BaseKanbanItem = BaseKanbanItem> {
	/** Unique board identifier */
	id: string;
	/** Board display name */
	name: string;
	/** Column definitions */
	columns: ColumnDefinition[];
	/** Frontmatter field mapping */
	fieldMapping: FieldMapping;
	/** Item filtering rules */
	itemFilter?: ItemFilter;
	/** FormKit drag-and-drop group name (defaults to board id) */
	dragGroup?: string;
	/** Custom item transformer - converts file + frontmatter to board item */
	itemTransformer?: (
		file: TFile,
		frontmatter: Record<string, unknown>
	) => T;
}
