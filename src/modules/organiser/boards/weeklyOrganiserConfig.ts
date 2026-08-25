import { moment } from "@/platform";
import { BoardConfig, ColumnDefinition } from "../types/kanban-config";
import { OrganiserItem, OrganiserItemType } from "../types";
import { OrganiserPreset } from "../presets/organiserPresets";
import { escapeHtml } from "@/shared/html";

const TYPE_ALIASES: Record<string, OrganiserItemType> = {
	meal: "recipe",
	meals: "recipe",
};
function getDayColumnGridPlacement(dayIndex: number): {
	gridRow: string;
	gridColumn: string;
} {
	if (dayIndex < 4) {
		const columnStart = dayIndex + 2;
		return {
			gridRow: "1 / 2",
			gridColumn: `${columnStart} / ${columnStart + 1}`,
		};
	}
	const columnStart = dayIndex - 2;
	return {
		gridRow: "2 / 3",
		gridColumn: `${columnStart} / ${columnStart + 1}`,
	};
}

function normalizeTypeValue(value: unknown): string | undefined {
	if (value === null || value === undefined) return undefined;
	const normalized = String(value).trim().toLowerCase();
	return normalized.length > 0 ? normalized : undefined;
}

function resolveCanonicalType(value: string): string {
	return TYPE_ALIASES[value] ?? value;
}

function normalizeTypeList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.map((entry) => normalizeTypeValue(entry))
			.filter((entry): entry is string => Boolean(entry));
	}
	const single = normalizeTypeValue(value);
	return single ? [single] : [];
}

function isTrueValue(value: unknown): boolean {
	if (value === true) return true;
	return String(value ?? "").trim().toLowerCase() === "true";
}

// Removed feature: office days. Any leftover `_mep/office-days/` content in an
// existing vault stays untouched on disk but never appears on the board.
export const LEGACY_OFFICE_DAYS_FOLDER = "_mep/office-days/";

function isInLegacyOfficeDaysFolder(path: string): boolean {
	return normalizeVaultPath(path).startsWith(`${LEGACY_OFFICE_DAYS_FOLDER}`);
}

function normalizeVaultPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function getAllowedTypes(preset: OrganiserPreset): Set<string> {
	const allowed: string[] = [];
	for (const value of preset.typeFilter) {
		const normalized = normalizeTypeValue(value);
		const canonical = normalized ? resolveCanonicalType(normalized) : undefined;
		if (canonical) allowed.push(canonical);
	}
	return new Set(allowed);
}

export function generateWeekColumns(
	weekOffset: number,
	dayNotes: Record<string, string> = {}
): ColumnDefinition[] {
	const startOfWeek = moment()
		.add(weekOffset, "weeks")
		.startOf("isoWeek");
	const markedColumn: ColumnDefinition = {
		id: "marked",
		title: "Marked",
		fieldValue: undefined,
		isDefault: true,
		gridRow: "1 / 3",
		gridColumn: "1 / 2",
	};

	const dayColumns: ColumnDefinition[] = [];
	for (let i = 0; i < 7; i++) {
		const date = startOfWeek.clone().add(i, "days");
		const dateId = date.format("YYYY-MM-DD");
		const note = dayNotes[dateId] || "";
		const noteHtml = `<button type="button" class="organiser-column-note ${
			note ? "has-note" : "is-empty"
		}" data-date="${dateId}" aria-label="Add note">${note ? escapeHtml(note) : "+"}</button>`;

		dayColumns.push({
			id: dateId,
			title: `<div class="organiser-column-header"><span class="organiser-column-title">${date.format(
				"ddd Do MMM"
			)}</span>${noteHtml}</div>`,
			fieldValue: dateId,
			...getDayColumnGridPlacement(i),
		});
	}

	return [markedColumn, ...dayColumns];
}

export function createWeeklyOrganiserConfig(
	weekOffset: number,
	preset: OrganiserPreset,
	dayNotes: Record<string, string> = {},
): BoardConfig<OrganiserItem> {
	const allowedTypes = getAllowedTypes(preset);
	const resolveType = (
		frontmatter: Record<string, unknown>
	): OrganiserItemType | undefined => {
		const typeValues = normalizeTypeList(frontmatter.type)
			.map((value) => resolveCanonicalType(value))
			.filter((value): value is OrganiserItemType => Boolean(value));
		const isQuickMealReminder =
			typeValues.includes("reminder") &&
			isTrueValue(frontmatter.quickMeal);
		if (isQuickMealReminder) {
			return "recipe";
		}
		return typeValues.find((value) => allowedTypes.has(value));
	};

	return {
		id: "weekly-organiser",
		name: preset.label,
		columns: generateWeekColumns(weekOffset, dayNotes),
		fieldMapping: {
			field: "scheduled",
			type: "date",
			fallbackField: "date",
			defaultField: "marked",
		},
		itemFilter: {
			customFilter: (file, frontmatter) =>
				!isInLegacyOfficeDaysFolder(file.path) && Boolean(resolveType(frontmatter)),
		},
		itemTransformer: (file, frontmatter) => {
			const resolvedType = resolveType(frontmatter) ?? "unknown";
			return {
				id: file.path,
				title:
					typeof frontmatter.title === "string" &&
					frontmatter.title.trim().length > 0
						? frontmatter.title.trim()
						: file.basename,
				path: file.path,
				type: resolvedType,
				coverImage: (frontmatter.cover ||
					frontmatter.image) as string | undefined,
				date: frontmatter.scheduled as string | undefined,
				added: frontmatter.added as string | undefined,
				marked: frontmatter.marked === true,
			};
		},
	};
}
