import { FieldType } from "../types/kanban-config";

export type OrganiserPresetId =
	| "weekly"
	| "meal"
	| "exercise"
	| "task";

export interface PresetFieldDefinition {
	key: string;
	label: string;
	type: FieldType;
	groupable?: boolean;
	sortable?: boolean;
}

export interface OrganiserPreset {
	id: OrganiserPresetId;
	label: string;
	description: string;
	isTimeBased: boolean;
	typeFilter: string[];
	fields: PresetFieldDefinition[];
}

function baseFields(): PresetFieldDefinition[] {
	return [
	{
		key: "type",
		label: "Type",
		type: "enum",
		groupable: true,
		sortable: true,
	},
	];
}

let _cachedPresets: OrganiserPreset[] | null = null;

function fallbackPresets(): OrganiserPreset[] {
	const fields = baseFields();
	return [
	{
		id: "weekly",
		label: "Weekly Planner",
		description: "All scheduled items for the week.",
		isTimeBased: true,
		typeFilter: ["recipe", "exercise", "task", "reminder"],
		fields,
	},
	{
		id: "meal",
		label: "Meal Planner",
		description: "Plan recipes across the week.",
		isTimeBased: true,
		typeFilter: ["recipe"],
		fields,
	},
	{
		id: "exercise",
		label: "Exercise Planner",
		description: "Schedule workouts for the week.",
		isTimeBased: true,
		typeFilter: ["exercise"],
		fields,
	},
	{
		id: "task",
		label: "Task Planner",
		description: "Track tasks across the week.",
		isTimeBased: true,
		typeFilter: ["task"],
		fields,
	},
	];
}

export function getOrganiserPresets(): OrganiserPreset[] {
	return _cachedPresets ??= fallbackPresets();
}

export function findPresetById(
	id: OrganiserPresetId | string
): OrganiserPreset {
	const presets = getOrganiserPresets();
	const match = presets.find((preset) => preset.id === id);
	return match ?? presets[0];
}
