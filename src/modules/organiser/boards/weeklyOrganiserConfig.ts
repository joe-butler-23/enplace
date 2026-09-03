import { addCalendarDays, formatIsoDate, formatPlannerDay, startOfIsoWeek } from "../utils/scheduled-dates";
import { BoardConfig, ColumnDefinition } from "../types/kanban-config";
import { escapeHtml } from "@/shared/html";

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


export function generateWeekColumns(
	weekOffset: number,
	dayNotes: Record<string, string> = {}
): ColumnDefinition[] {
	const startOfWeek = addCalendarDays(startOfIsoWeek(), weekOffset * 7);
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
		const date = addCalendarDays(startOfWeek, i);
		const dateId = formatIsoDate(date);
		const note = dayNotes[dateId] || "";
		const noteHtml = `<button type="button" class="organiser-column-note ${
			note ? "has-note" : "is-empty"
		}" data-date="${dateId}" aria-label="Add note">${note ? escapeHtml(note) : "+"}</button>`;

		dayColumns.push({
			id: dateId,
			title: `<div class="organiser-column-header"><span class="organiser-column-title">${formatPlannerDay(date)}</span>${noteHtml}</div>`,
			fieldValue: dateId,
			...getDayColumnGridPlacement(i),
		});
	}

	return [markedColumn, ...dayColumns];
}

export function createWeeklyOrganiserConfig(
  weekOffset: number,
  dayNotes: Record<string, string> = {},
): BoardConfig {
  return {
    id: "weekly-organiser",
    name: "Weekly Planner",
    columns: generateWeekColumns(weekOffset, dayNotes),
  };
}
